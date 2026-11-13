// SPDX-License-Identifier: Dual BSD/GPL
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include "witness_event.h"

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);
    __type(value, __u64);
} watched_cgroups SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct witness_stats);
} stats_map SEC(".maps");

static __always_inline int emit_witness_event(
    __u64 cgroup_id,
    __u32 event_type,
    __u32 pid,
    __u32 tgid,
    __u32 ppid,
    __u32 child_pid,
    __u32 child_tgid,
    __s32 exit_code,
    const char *explicit_comm)
{
    __u64 *tag = bpf_map_lookup_elem(&watched_cgroups, &cgroup_id);
    if (!tag) {
        return 0;
    }

    __u32 stats_key = 0;
    struct witness_stats *stats = bpf_map_lookup_elem(&stats_map, &stats_key);
    if (!stats) {
        return 0;
    }

    __u64 seq = __sync_fetch_and_add(&stats->seq_counter, 1) + 1;
    __sync_fetch_and_add(&stats->total_events, 1);

    struct witness_event *ev = bpf_ringbuf_reserve(&events, sizeof(*ev), 0);
    if (!ev) {
        __sync_fetch_and_add(&stats->dropped_events, 1);
        return 0;
    }

    __u64 uid_gid = bpf_get_current_uid_gid();
    ev->seq = seq;
    ev->timestamp_ns = bpf_ktime_get_ns();
    ev->cgroup_id = cgroup_id;
    ev->event_type = event_type;
    ev->pid = pid;
    ev->tgid = tgid;
    ev->ppid = ppid;
    ev->child_pid = child_pid;
    ev->child_tgid = child_tgid;
    ev->uid = (__u32)(uid_gid & 0xffffffffULL);
    ev->gid = (__u32)(uid_gid >> 32);
    ev->exit_code = exit_code;

    __builtin_memset(ev->comm, 0, sizeof(ev->comm));
    if (explicit_comm) {
        bpf_probe_read_kernel_str(ev->comm, sizeof(ev->comm), explicit_comm);
    } else {
        bpf_get_current_comm(ev->comm, sizeof(ev->comm));
    }

    bpf_ringbuf_submit(ev, 0);
    return 0;
}

SEC("tp_btf/sched_process_fork")
int BPF_PROG(handle_sched_process_fork, struct task_struct *parent, struct task_struct *child)
{
    __u64 parent_cg = BPF_CORE_READ(parent, cgroups, dfl_cgrp, kn, id);
    __u64 child_cg = BPF_CORE_READ(child, cgroups, dfl_cgrp, kn, id);
    __u64 matched_cg = 0;

    if (bpf_map_lookup_elem(&watched_cgroups, &child_cg)) {
        matched_cg = child_cg;
    } else if (bpf_map_lookup_elem(&watched_cgroups, &parent_cg)) {
        matched_cg = parent_cg;
    } else {
        return 0;
    }

    __u32 pid = BPF_CORE_READ(parent, pid);
    __u32 tgid = BPF_CORE_READ(parent, tgid);
    __u32 ppid = BPF_CORE_READ(parent, real_parent, tgid);
    __u32 child_pid = BPF_CORE_READ(child, pid);
    __u32 child_tgid = BPF_CORE_READ(child, tgid);

    return emit_witness_event(
        matched_cg,
        WITNESS_EVENT_FORK,
        pid,
        tgid,
        ppid,
        child_pid,
        child_tgid,
        0,
        NULL
    );
}

SEC("tp/sched/sched_process_exec")
int handle_sched_process_exec(struct trace_event_raw_sched_process_exec *ctx)
{
    __u64 cgroup_id = bpf_get_current_cgroup_id();
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = (__u32)(pid_tgid & 0xffffffffULL);
    __u32 tgid = (__u32)(pid_tgid >> 32);

    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    __u32 ppid = BPF_CORE_READ(task, real_parent, tgid);

    return emit_witness_event(
        cgroup_id,
        WITNESS_EVENT_EXEC,
        pid,
        tgid,
        ppid,
        0,
        0,
        0,
        NULL
    );
}

SEC("tp/sched/sched_process_exit")
int handle_sched_process_exit(struct trace_event_raw_sched_process_exit *ctx)
{
    __u64 cgroup_id = bpf_get_current_cgroup_id();
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = (__u32)(pid_tgid & 0xffffffffULL);
    __u32 tgid = (__u32)(pid_tgid >> 32);

    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    __u32 ppid = BPF_CORE_READ(task, real_parent, tgid);
    __s32 exit_code = BPF_CORE_READ(task, exit_code);

    return emit_witness_event(
        cgroup_id,
        WITNESS_EVENT_EXIT,
        pid,
        tgid,
        ppid,
        0,
        0,
        exit_code,
        NULL
    );
}
