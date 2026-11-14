// SPDX-License-Identifier: Dual BSD/GPL
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>
#include "witness_event.h"

char LICENSE[] SEC("license") = "Dual BSD/GPL";

#define KW_AF_INET  2
#define KW_AF_INET6 10
#define KW_IPPROTO_TCP 6
#define KW_IPPROTO_UDP 17

#define KW_S_IFMT  00170000
#define KW_S_IFREG 0100000
#define KW_S_IFDIR 0040000

#define KW_O_ACCMODE 00000003
#define KW_O_RDONLY  00000000
#define KW_O_WRONLY  00000001
#define KW_O_RDWR    00000002
#define KW_O_CREAT   00000100
#define KW_O_TRUNC   00001000
#define KW_O_TMPFILE 020200000

#define KW_AT_REMOVEDIR 0x200
#define KW_PROT_WRITE   0x2
#define KW_MAP_TYPE     0x0f
#define KW_MAP_SHARED   0x01
#define KW_MAP_SHARED_VALIDATE 0x03

struct inode_key {
    __u64 dev;
    __u64 inode;
};

struct path_val {
    char path[JC_WITNESS_PATH_LEN];
};

struct pending_fs_ctx {
    __u64 cgroup_id;
    __u32 op;
    __u64 flags;
    __u64 bytes;
    __u64 dev;
    __u64 inode;
    __u64 target_inode;
    __u32 mount_id;
    char path[JC_WITNESS_PATH_LEN];
    char target_path[JC_WITNESS_PATH_LEN];
};

struct watched_sock_ctx {
    __u64 cgroup_id;
    __u32 pid;
    __u32 tgid;
    __u32 uid;
    __u32 gid;
    __u64 sock_cookie;
    __u16 af;
    __u16 proto;
    __u16 local_port;
    __u16 remote_port;
    __u32 remote_ip4;
    __u8  remote_ip6[16];
    char  comm[JC_WITNESS_COMM_LEN];
};

struct pending_connect_ctx {
    __u64 cgroup_id;
    __u64 sk_ptr;
    __u64 sock_cookie;
    __u16 af;
    __u16 proto;
    __u16 local_port;
    __u16 remote_port;
    __u32 remote_ip4;
    __u8  remote_ip6[16];
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);
    __type(value, __u64);
} watched_cgroups SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 512 * 1024);
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct witness_stats);
} stats_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);
    __type(value, struct pending_fs_ctx);
} in_flight_fs SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 4096);
    __type(key, struct inode_key);
    __type(value, struct path_val);
} inode_paths SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);
    __type(value, struct watched_sock_ctx);
} watched_sockets SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);
    __type(value, struct pending_connect_ctx);
} in_flight_connect SEC(".maps");

static __always_inline __u64 resolve_watched_cgroup(void)
{
    __u64 cg_id = bpf_get_current_cgroup_id();
    __u64 *tag = bpf_map_lookup_elem(&watched_cgroups, &cg_id);
    if (tag) {
        return (*tag > 1) ? *tag : cg_id;
    }

    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    struct kernfs_node *kn = BPF_CORE_READ(task, cgroups, dfl_cgrp, kn);
    #pragma unroll
    for (int i = 0; i < 4; ++i) {
        if (!kn) break;
        kn = BPF_CORE_READ(kn, __parent);
        if (!kn) break;
        __u64 parent_id = BPF_CORE_READ(kn, id);
        __u64 *ptag = bpf_map_lookup_elem(&watched_cgroups, &parent_id);
        if (ptag) {
            __u64 root_cg = (*ptag > 1) ? *ptag : parent_id;
            bpf_map_update_elem(&watched_cgroups, &cg_id, &root_cg, BPF_ANY);
            return root_cg;
        }
    }
    return 0;
}

static __always_inline struct witness_event *reserve_event_slot(
    __u64 cgroup_id,
    __u32 event_type,
    __u32 op)
{
    __u32 stats_key = 0;
    struct witness_stats *stats = bpf_map_lookup_elem(&stats_map, &stats_key);
    if (!stats) {
        return NULL;
    }

    __u64 seq = __sync_fetch_and_add(&stats->seq_counter, 1) + 1;
    __sync_fetch_and_add(&stats->total_events, 1);

    if (event_type == WITNESS_EVENT_FS) {
        __sync_fetch_and_add(&stats->fs_events, 1);
        if (op == WITNESS_FS_MMAP_WRITE) {
            __sync_fetch_and_add(&stats->mmap_write_events, 1);
        } else if (op == WITNESS_FS_IO_URING) {
            __sync_fetch_and_add(&stats->io_uring_events, 1);
        }
    } else if (event_type == WITNESS_EVENT_NET) {
        __sync_fetch_and_add(&stats->net_events, 1);
    } else {
        __sync_fetch_and_add(&stats->process_events, 1);
    }

    struct witness_event *ev = bpf_ringbuf_reserve(&events, sizeof(*ev), 0);
    if (!ev) {
        __sync_fetch_and_add(&stats->dropped_events, 1);
        if (event_type == WITNESS_EVENT_FS) {
            __sync_fetch_and_add(&stats->fs_drops, 1);
        } else if (event_type == WITNESS_EVENT_NET) {
            __sync_fetch_and_add(&stats->net_drops, 1);
        } else {
            __sync_fetch_and_add(&stats->process_drops, 1);
        }
        return NULL;
    }

    __builtin_memset(ev, 0, sizeof(*ev));
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u64 uid_gid = bpf_get_current_uid_gid();

    ev->seq = seq;
    ev->timestamp_ns = bpf_ktime_get_ns();
    ev->cgroup_id = cgroup_id;
    ev->event_type = event_type;
    ev->pid = (__u32)(pid_tgid & 0xffffffffULL);
    ev->tgid = (__u32)(pid_tgid >> 32);
    ev->uid = (__u32)(uid_gid & 0xffffffffULL);
    ev->gid = (__u32)(uid_gid >> 32);
    ev->op = op;
    bpf_get_current_comm(ev->comm, sizeof(ev->comm));
    return ev;
}

static __always_inline int emit_process_event(
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
    struct witness_event *ev = reserve_event_slot(cgroup_id, event_type, 0);
    if (!ev) {
        return 0;
    }
    ev->pid = pid;
    ev->tgid = tgid;
    ev->ppid = ppid;
    ev->child_pid = child_pid;
    ev->child_tgid = child_tgid;
    ev->exit_code = exit_code;
    if (explicit_comm) {
        __builtin_memset(ev->comm, 0, sizeof(ev->comm));
        bpf_probe_read_kernel_str(ev->comm, sizeof(ev->comm), explicit_comm);
    }
    bpf_ringbuf_submit(ev, 0);
    return 0;
}

static __always_inline struct file *resolve_fd_file(int fd)
{
    if (fd < 0 || fd >= 4096) return NULL;
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    struct fdtable *fdt = BPF_CORE_READ(task, files, fdt);
    if (!fdt) return NULL;
    unsigned int max_fds = BPF_CORE_READ(fdt, max_fds);
    if ((unsigned int)fd >= max_fds) return NULL;
    struct file **fd_arr = BPF_CORE_READ(fdt, fd);
    if (!fd_arr) return NULL;
    struct file *f = NULL;
    bpf_probe_read_kernel(&f, sizeof(f), &fd_arr[fd]);
    return f;
}

static __always_inline __u32 extract_mount_id(const struct vfsmount *mnt)
{
    if (!mnt) return 0;
    const struct mount *m = (const struct mount *)((const char *)mnt - bpf_core_field_offset(struct mount, mnt));
    return (__u32)BPF_CORE_READ(m, mnt_id);
}

static __always_inline void populate_file_meta(
    struct file *f,
    __u64 *dev_out,
    __u64 *inode_out,
    __u32 *mount_id_out,
    char *path_buf)
{
    if (!f) return;
    struct inode *ino = BPF_CORE_READ(f, f_inode);
    if (ino) {
        *inode_out = BPF_CORE_READ(ino, i_ino);
        *dev_out = (__u64)BPF_CORE_READ(ino, i_sb, s_dev);
    }
    struct vfsmount *mnt = BPF_CORE_READ(f, f_path.mnt);
    *mount_id_out = extract_mount_id(mnt);

    if (path_buf && path_buf[0] == '\0') {
        struct inode_key ik = { .dev = *dev_out, .inode = *inode_out };
        struct path_val *pv = bpf_map_lookup_elem(&inode_paths, &ik);
        if (pv && pv->path[0] != '\0') {
            bpf_probe_read_kernel_str(path_buf, JC_WITNESS_PATH_LEN, pv->path);
            return;
        }
        struct dentry *dentry = BPF_CORE_READ(f, f_path.dentry);
        if (dentry) {
            const unsigned char *dname = BPF_CORE_READ(dentry, d_name.name);
            if (dname) {
                bpf_probe_read_kernel_str(path_buf, JC_WITNESS_PATH_LEN, dname);
            }
        }
    }
}

static __always_inline void emit_fs_event_from_ctx(
    const struct pending_fs_ctx *pctx,
    __u32 phase,
    __s32 result_errno,
    __u64 completed_bytes)
{
    struct witness_event *ev = reserve_event_slot(pctx->cgroup_id, WITNESS_EVENT_FS, pctx->op);
    if (!ev) return;
    ev->phase = phase;
    ev->result_errno = result_errno;
    ev->bytes = completed_bytes;
    ev->flags = pctx->flags;
    ev->dev = pctx->dev;
    ev->inode = pctx->inode;
    ev->target_inode = pctx->target_inode;
    ev->mount_id = pctx->mount_id;
    bpf_probe_read_kernel_str(ev->path, sizeof(ev->path), pctx->path);
    if (pctx->target_path[0] != '\0') {
        bpf_probe_read_kernel_str(ev->target_path, sizeof(ev->target_path), pctx->target_path);
    }
    bpf_ringbuf_submit(ev, 0);
}

static __always_inline int finish_fs_syscall(long ret, bool update_bytes_from_ret, bool is_open_fd)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    struct pending_fs_ctx *pctx = bpf_map_lookup_elem(&in_flight_fs, &pid_tgid);
    if (!pctx) return 0;

    if (is_open_fd && ret >= 0) {
        struct file *f = resolve_fd_file((int)ret);
        if (f) {
            populate_file_meta(f, &pctx->dev, &pctx->inode, &pctx->mount_id, NULL);
            if (pctx->inode != 0 && pctx->path[0] != '\0') {
                struct inode_key ik = { .dev = pctx->dev, .inode = pctx->inode };
                struct path_val pv = {};
                bpf_probe_read_kernel_str(pv.path, sizeof(pv.path), pctx->path);
                bpf_map_update_elem(&inode_paths, &ik, &pv, BPF_ANY);
            }
        }
    } else if (pctx->op == WITNESS_FS_RENAME && ret >= 0 && pctx->inode != 0 && pctx->target_path[0] != '\0') {
        struct inode_key ik = { .dev = pctx->dev, .inode = pctx->inode };
        struct path_val pv = {};
        bpf_probe_read_kernel_str(pv.path, sizeof(pv.path), pctx->target_path);
        bpf_map_update_elem(&inode_paths, &ik, &pv, BPF_ANY);
    }

    __s32 err = (ret < 0) ? (__s32)(-ret) : 0;
    __u64 bytes = pctx->bytes;
    if (update_bytes_from_ret) {
        bytes = (ret >= 0) ? (__u64)ret : 0;
    }

    emit_fs_event_from_ctx(pctx, WITNESS_PHASE_COMPLETED, err, bytes);
    bpf_map_delete_elem(&in_flight_fs, &pid_tgid);
    return 0;
}

/* =========================================================================
 * Process Observation Hooks (Phase 1 / 3)
 * ========================================================================= */

SEC("tp_btf/sched_process_fork")
int BPF_PROG(handle_sched_process_fork, struct task_struct *parent, struct task_struct *child)
{
    __u64 parent_cg = BPF_CORE_READ(parent, cgroups, dfl_cgrp, kn, id);
    __u64 child_cg = BPF_CORE_READ(child, cgroups, dfl_cgrp, kn, id);
    __u64 *child_tag = bpf_map_lookup_elem(&watched_cgroups, &child_cg);
    __u64 *parent_tag = bpf_map_lookup_elem(&watched_cgroups, &parent_cg);
    __u64 matched_cg = 0;

    if (child_tag) {
        matched_cg = (*child_tag > 1) ? *child_tag : child_cg;
    } else if (parent_tag) {
        matched_cg = (*parent_tag > 1) ? *parent_tag : parent_cg;
        if (child_cg != 0 && child_cg != parent_cg) {
            bpf_map_update_elem(&watched_cgroups, &child_cg, &matched_cg, BPF_ANY);
        }
    } else {
        return 0;
    }

    __u32 pid = BPF_CORE_READ(parent, pid);
    __u32 tgid = BPF_CORE_READ(parent, tgid);
    __u32 ppid = BPF_CORE_READ(parent, real_parent, tgid);
    __u32 child_pid = BPF_CORE_READ(child, pid);
    __u32 child_tgid = BPF_CORE_READ(child, tgid);

    /* Ignore CLONE_THREAD intra-process thread creation so process tree has no self-loops */
    if (child_tgid == tgid && child_pid != child_tgid) {
        return 0;
    }

    return emit_process_event(
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
    __u64 cgroup_id = resolve_watched_cgroup();
    if (!cgroup_id) return 0;

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = (__u32)(pid_tgid & 0xffffffffULL);
    __u32 tgid = (__u32)(pid_tgid >> 32);

    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    __u32 ppid = BPF_CORE_READ(task, real_parent, tgid);

    return emit_process_event(
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
    __u64 cgroup_id = resolve_watched_cgroup();
    if (!cgroup_id) return 0;

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = (__u32)(pid_tgid & 0xffffffffULL);
    __u32 tgid = (__u32)(pid_tgid >> 32);

    /* Only emit EXIT for thread-group leaders */
    if (pid != tgid) {
        return 0;
    }

    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    __u32 ppid = BPF_CORE_READ(task, real_parent, tgid);
    __s32 exit_code = BPF_CORE_READ(task, exit_code);

    return emit_process_event(
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

/* =========================================================================
 * Phase 4: Filesystem Observation Hooks (Syscalls + VFS CO-RE)
 * ========================================================================= */

static __always_inline int start_open_syscall(__u64 cgroup_id, const char *u_path, __u64 flags, bool force_create)
{
    __u32 op = 0;
    if (force_create || (flags & KW_O_CREAT)) {
        op = WITNESS_FS_CREATE;
    } else if (flags & KW_O_TRUNC) {
        op = WITNESS_FS_TRUNCATE;
    } else if ((flags & KW_O_ACCMODE) != KW_O_RDONLY || (flags & KW_O_TMPFILE)) {
        op = WITNESS_FS_OPENAT;
    } else {
        /* Read-only open without O_CREAT/O_TRUNC */
        return 0;
    }

    struct pending_fs_ctx pctx = {};
    pctx.cgroup_id = cgroup_id;
    pctx.op = op;
    pctx.flags = flags;
    if (u_path) {
        bpf_probe_read_user_str(pctx.path, sizeof(pctx.path), u_path);
    }

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    bpf_map_update_elem(&in_flight_fs, &pid_tgid, &pctx, BPF_ANY);
    emit_fs_event_from_ctx(&pctx, WITNESS_PHASE_ATTEMPTED, 0, 0);
    return 0;
}

SEC("tp/syscalls/sys_enter_openat")
int handle_sys_enter_openat(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    const char *u_path = (const char *)ctx->args[1];
    __u64 flags = (__u64)ctx->args[2];
    return start_open_syscall(cg, u_path, flags, false);
}

SEC("tp/syscalls/sys_exit_openat")
int handle_sys_exit_openat(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, true);
}

SEC("tp/syscalls/sys_enter_openat2")
int handle_sys_enter_openat2(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    const char *u_path = (const char *)ctx->args[1];
    const struct open_how *u_how = (const struct open_how *)ctx->args[2];
    __u64 flags = 0;
    if (u_how) {
        bpf_probe_read_user(&flags, sizeof(flags), &u_how->flags);
    }
    return start_open_syscall(cg, u_path, flags, false);
}

SEC("tp/syscalls/sys_exit_openat2")
int handle_sys_exit_openat2(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, true);
}

SEC("tp/syscalls/sys_enter_creat")
int handle_sys_enter_creat(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    const char *u_path = (const char *)ctx->args[0];
    return start_open_syscall(cg, u_path, KW_O_CREAT | KW_O_WRONLY | KW_O_TRUNC, true);
}

SEC("tp/syscalls/sys_exit_creat")
int handle_sys_exit_creat(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, true);
}

static __always_inline int start_fd_modify_syscall(__u64 cg, int fd, __u64 count)
{
    struct file *f = resolve_fd_file(fd);
    if (!f) return 0;
    struct inode *ino = BPF_CORE_READ(f, f_inode);
    if (!ino) return 0;
    umode_t mode = BPF_CORE_READ(ino, i_mode);
    if ((mode & KW_S_IFMT) != KW_S_IFREG) {
        return 0;
    }

    struct pending_fs_ctx pctx = {};
    pctx.cgroup_id = cg;
    pctx.op = WITNESS_FS_MODIFY;
    pctx.bytes = count;
    pctx.flags = (__u64)BPF_CORE_READ(f, f_flags);
    populate_file_meta(f, &pctx.dev, &pctx.inode, &pctx.mount_id, pctx.path);

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    bpf_map_update_elem(&in_flight_fs, &pid_tgid, &pctx, BPF_ANY);
    emit_fs_event_from_ctx(&pctx, WITNESS_PHASE_ATTEMPTED, 0, count);
    return 0;
}

SEC("tp/syscalls/sys_enter_write")
int handle_sys_enter_write(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_fd_modify_syscall(cg, (int)ctx->args[0], (__u64)ctx->args[2]);
}

SEC("tp/syscalls/sys_exit_write")
int handle_sys_exit_write(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, true, false);
}

SEC("tp/syscalls/sys_enter_writev")
int handle_sys_enter_writev(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_fd_modify_syscall(cg, (int)ctx->args[0], (__u64)ctx->args[2]);
}

SEC("tp/syscalls/sys_exit_writev")
int handle_sys_exit_writev(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, true, false);
}

SEC("tp/syscalls/sys_enter_pwrite64")
int handle_sys_enter_pwrite64(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_fd_modify_syscall(cg, (int)ctx->args[0], (__u64)ctx->args[2]);
}

SEC("tp/syscalls/sys_exit_pwrite64")
int handle_sys_exit_pwrite64(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, true, false);
}

SEC("tp/syscalls/sys_enter_truncate")
int handle_sys_enter_truncate(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    struct pending_fs_ctx pctx = {};
    pctx.cgroup_id = cg;
    pctx.op = WITNESS_FS_TRUNCATE;
    pctx.bytes = (__u64)ctx->args[1];
    const char *u_path = (const char *)ctx->args[0];
    if (u_path) {
        bpf_probe_read_user_str(pctx.path, sizeof(pctx.path), u_path);
    }
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    bpf_map_update_elem(&in_flight_fs, &pid_tgid, &pctx, BPF_ANY);
    emit_fs_event_from_ctx(&pctx, WITNESS_PHASE_ATTEMPTED, 0, pctx.bytes);
    return 0;
}

SEC("tp/syscalls/sys_exit_truncate")
int handle_sys_exit_truncate(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

SEC("tp/syscalls/sys_enter_ftruncate")
int handle_sys_enter_ftruncate(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    int fd = (int)ctx->args[0];
    struct file *f = resolve_fd_file(fd);
    if (!f) return 0;
    struct inode *ino = BPF_CORE_READ(f, f_inode);
    if (!ino) return 0;
    umode_t mode = BPF_CORE_READ(ino, i_mode);
    if ((mode & KW_S_IFMT) != KW_S_IFREG) return 0;

    struct pending_fs_ctx pctx = {};
    pctx.cgroup_id = cg;
    pctx.op = WITNESS_FS_TRUNCATE;
    pctx.bytes = (__u64)ctx->args[1];
    populate_file_meta(f, &pctx.dev, &pctx.inode, &pctx.mount_id, pctx.path);

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    bpf_map_update_elem(&in_flight_fs, &pid_tgid, &pctx, BPF_ANY);
    emit_fs_event_from_ctx(&pctx, WITNESS_PHASE_ATTEMPTED, 0, pctx.bytes);
    return 0;
}

SEC("tp/syscalls/sys_exit_ftruncate")
int handle_sys_exit_ftruncate(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

static __always_inline int start_path_op(__u64 cg, __u32 op, const char *u_path, __u64 flags)
{
    struct pending_fs_ctx pctx = {};
    pctx.cgroup_id = cg;
    pctx.op = op;
    pctx.flags = flags;
    if (u_path) {
        bpf_probe_read_user_str(pctx.path, sizeof(pctx.path), u_path);
    }
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    bpf_map_update_elem(&in_flight_fs, &pid_tgid, &pctx, BPF_ANY);
    emit_fs_event_from_ctx(&pctx, WITNESS_PHASE_ATTEMPTED, 0, 0);
    return 0;
}

SEC("tp/syscalls/sys_enter_unlink")
int handle_sys_enter_unlink(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_path_op(cg, WITNESS_FS_DELETE, (const char *)ctx->args[0], 0);
}

SEC("tp/syscalls/sys_exit_unlink")
int handle_sys_exit_unlink(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

SEC("tp/syscalls/sys_enter_unlinkat")
int handle_sys_enter_unlinkat(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    __u64 flags = (__u64)ctx->args[2];
    __u32 op = (flags & KW_AT_REMOVEDIR) ? WITNESS_FS_RMDIR : WITNESS_FS_DELETE;
    return start_path_op(cg, op, (const char *)ctx->args[1], flags);
}

SEC("tp/syscalls/sys_exit_unlinkat")
int handle_sys_exit_unlinkat(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

SEC("tp/syscalls/sys_enter_mkdir")
int handle_sys_enter_mkdir(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_path_op(cg, WITNESS_FS_MKDIR, (const char *)ctx->args[0], (__u64)ctx->args[1]);
}

SEC("tp/syscalls/sys_exit_mkdir")
int handle_sys_exit_mkdir(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

SEC("tp/syscalls/sys_enter_mkdirat")
int handle_sys_enter_mkdirat(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_path_op(cg, WITNESS_FS_MKDIR, (const char *)ctx->args[1], (__u64)ctx->args[2]);
}

SEC("tp/syscalls/sys_exit_mkdirat")
int handle_sys_exit_mkdirat(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

SEC("tp/syscalls/sys_enter_rmdir")
int handle_sys_enter_rmdir(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_path_op(cg, WITNESS_FS_RMDIR, (const char *)ctx->args[0], 0);
}

SEC("tp/syscalls/sys_exit_rmdir")
int handle_sys_exit_rmdir(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

static __always_inline int start_rename_op(__u64 cg, const char *u_old, const char *u_new, __u64 flags)
{
    struct pending_fs_ctx pctx = {};
    pctx.cgroup_id = cg;
    pctx.op = WITNESS_FS_RENAME;
    pctx.flags = flags;
    if (u_old) bpf_probe_read_user_str(pctx.path, sizeof(pctx.path), u_old);
    if (u_new) bpf_probe_read_user_str(pctx.target_path, sizeof(pctx.target_path), u_new);

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    bpf_map_update_elem(&in_flight_fs, &pid_tgid, &pctx, BPF_ANY);
    emit_fs_event_from_ctx(&pctx, WITNESS_PHASE_ATTEMPTED, 0, 0);
    return 0;
}

SEC("tp/syscalls/sys_enter_rename")
int handle_sys_enter_rename(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_rename_op(cg, (const char *)ctx->args[0], (const char *)ctx->args[1], 0);
}

SEC("tp/syscalls/sys_exit_rename")
int handle_sys_exit_rename(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

SEC("tp/syscalls/sys_enter_renameat")
int handle_sys_enter_renameat(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_rename_op(cg, (const char *)ctx->args[1], (const char *)ctx->args[3], 0);
}

SEC("tp/syscalls/sys_exit_renameat")
int handle_sys_exit_renameat(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

SEC("tp/syscalls/sys_enter_renameat2")
int handle_sys_enter_renameat2(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    return start_rename_op(cg, (const char *)ctx->args[1], (const char *)ctx->args[3], (__u64)ctx->args[4]);
}

SEC("tp/syscalls/sys_exit_renameat2")
int handle_sys_exit_renameat2(struct trace_event_raw_sys_exit *ctx)
{
    return finish_fs_syscall(ctx->ret, false, false);
}

/* VFS CO-RE Enrichment Hooks */

static __always_inline void enrich_in_flight_dentry(struct dentry *dentry)
{
    if (!dentry) return;
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    struct pending_fs_ctx *pctx = bpf_map_lookup_elem(&in_flight_fs, &pid_tgid);
    if (!pctx) return;

    struct inode *ino = BPF_CORE_READ(dentry, d_inode);
    if (ino) {
        pctx->inode = BPF_CORE_READ(ino, i_ino);
        pctx->dev = (__u64)BPF_CORE_READ(ino, i_sb, s_dev);
    } else {
        struct super_block *sb = BPF_CORE_READ(dentry, d_sb);
        if (sb) pctx->dev = (__u64)BPF_CORE_READ(sb, s_dev);
    }
}

SEC("fentry/vfs_create")
int BPF_PROG(handle_vfs_create, struct mnt_idmap *idmap, struct dentry *dentry)
{
    enrich_in_flight_dentry(dentry);
    return 0;
}

SEC("fentry/vfs_unlink")
int BPF_PROG(handle_vfs_unlink, struct mnt_idmap *idmap, struct inode *dir, struct dentry *dentry)
{
    enrich_in_flight_dentry(dentry);
    return 0;
}

SEC("fentry/vfs_mkdir")
int BPF_PROG(handle_vfs_mkdir, struct mnt_idmap *idmap, struct inode *dir, struct dentry *dentry)
{
    enrich_in_flight_dentry(dentry);
    return 0;
}

SEC("fentry/vfs_rmdir")
int BPF_PROG(handle_vfs_rmdir, struct mnt_idmap *idmap, struct inode *dir, struct dentry *dentry)
{
    enrich_in_flight_dentry(dentry);
    return 0;
}

SEC("fentry/vfs_truncate")
int BPF_PROG(handle_vfs_truncate, const struct path *path)
{
    if (!path) return 0;
    struct dentry *dentry = BPF_CORE_READ(path, dentry);
    enrich_in_flight_dentry(dentry);
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    struct pending_fs_ctx *pctx = bpf_map_lookup_elem(&in_flight_fs, &pid_tgid);
    if (pctx) {
        struct vfsmount *mnt = BPF_CORE_READ(path, mnt);
        pctx->mount_id = extract_mount_id(mnt);
    }
    return 0;
}

SEC("fentry/vfs_rename")
int BPF_PROG(handle_vfs_rename, struct renamedata *rd)
{
    if (!rd) return 0;
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    struct pending_fs_ctx *pctx = bpf_map_lookup_elem(&in_flight_fs, &pid_tgid);
    if (!pctx) return 0;

    struct dentry *old_d = BPF_CORE_READ(rd, old_dentry);
    struct dentry *new_d = BPF_CORE_READ(rd, new_dentry);
    if (old_d) {
        struct inode *ino = BPF_CORE_READ(old_d, d_inode);
        if (ino) {
            pctx->inode = BPF_CORE_READ(ino, i_ino);
            pctx->dev = (__u64)BPF_CORE_READ(ino, i_sb, s_dev);
        }
    }
    if (new_d) {
        struct inode *t_ino = BPF_CORE_READ(new_d, d_inode);
        if (t_ino) {
            pctx->target_inode = BPF_CORE_READ(t_ino, i_ino);
        }
    }
    return 0;
}

/* Completeness visibility hooks for MMAP_WRITE and IO_URING */

SEC("fexit/vm_mmap_pgoff")
int BPF_PROG(handle_vm_mmap_pgoff,
    struct file *file,
    unsigned long addr,
    unsigned long len,
    unsigned long prot,
    unsigned long flag,
    unsigned long pgoff,
    unsigned long ret)
{
    if (!file) return 0;
    if (!(prot & KW_PROT_WRITE)) return 0;
    unsigned long map_type = flag & KW_MAP_TYPE;
    if (map_type != KW_MAP_SHARED && map_type != KW_MAP_SHARED_VALIDATE) return 0;

    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;

    struct inode *ino = BPF_CORE_READ(file, f_inode);
    if (!ino) return 0;
    umode_t mode = BPF_CORE_READ(ino, i_mode);
    if ((mode & KW_S_IFMT) != KW_S_IFREG) return 0;

    struct witness_event *ev = reserve_event_slot(cg, WITNESS_EVENT_FS, WITNESS_FS_MMAP_WRITE);
    if (!ev) return 0;

    ev->phase = WITNESS_PHASE_COMPLETED;
    ev->bytes = (__u64)len;
    ev->flags = (__u64)flag;
    ev->result_errno = (ret >= (unsigned long)-4095UL) ? (__s32)(-(long)ret) : 0;
    populate_file_meta(file, &ev->dev, &ev->inode, &ev->mount_id, ev->path);
    bpf_ringbuf_submit(ev, 0);
    return 0;
}

SEC("tp/syscalls/sys_enter_io_uring_setup")
int handle_sys_enter_io_uring_setup(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    struct witness_event *ev = reserve_event_slot(cg, WITNESS_EVENT_FS, WITNESS_FS_IO_URING);
    if (!ev) return 0;
    ev->phase = WITNESS_PHASE_ATTEMPTED;
    ev->flags = (__u64)ctx->args[0];
    bpf_ringbuf_submit(ev, 0);
    return 0;
}

SEC("tp/syscalls/sys_enter_io_uring_enter")
int handle_sys_enter_io_uring_enter(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;
    struct witness_event *ev = reserve_event_slot(cg, WITNESS_EVENT_FS, WITNESS_FS_IO_URING);
    if (!ev) return 0;
    ev->phase = WITNESS_PHASE_ATTEMPTED;
    ev->flags = (__u64)ctx->args[1];
    bpf_ringbuf_submit(ev, 0);
    return 0;
}

/* =========================================================================
 * Phase 5: Network Observation Hooks (TCP/UDP IPv4 & IPv6 CO-RE)
 * ========================================================================= */

static __always_inline __u64 derive_sock_cookie(const struct sock *sk)
{
    if (!sk) return 0;
    __s64 c = BPF_CORE_READ(sk, __sk_common.skc_cookie.counter);
    if (c != 0) return (__u64)c;
    return (__u64)(unsigned long)sk;
}

static __always_inline __u32 errno_to_net_outcome(__s32 err)
{
    if (err == 0) return WITNESS_NET_OUTCOME_CONNECTED;
    if (err == 115) return WITNESS_NET_OUTCOME_IN_PROGRESS; /* EINPROGRESS */
    if (err == 111) return WITNESS_NET_OUTCOME_REFUSED;     /* ECONNREFUSED */
    if (err == 110) return WITNESS_NET_OUTCOME_TIMED_OUT;   /* ETIMEDOUT */
    if (err == 101 || err == 113) return WITNESS_NET_OUTCOME_UNREACHABLE; /* ENETUNREACH / EHOSTUNREACH */
    return WITNESS_NET_OUTCOME_FAILED;
}

SEC("tp/syscalls/sys_enter_connect")
int handle_sys_enter_connect(struct trace_event_raw_sys_enter *ctx)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg) return 0;

    const struct sockaddr *uaddr = (const struct sockaddr *)ctx->args[1];
    int addrlen = (int)ctx->args[2];
    if (!uaddr || addrlen < 2) return 0;

    __u16 sa_family = 0;
    bpf_probe_read_user(&sa_family, sizeof(sa_family), &uaddr->sa_family);
    if (sa_family != KW_AF_INET && sa_family != KW_AF_INET6) {
        return 0;
    }

    struct pending_connect_ctx pconn = {};
    pconn.cgroup_id = cg;
    pconn.af = sa_family;
    pconn.proto = KW_IPPROTO_TCP;

    if (sa_family == KW_AF_INET && addrlen >= (int)sizeof(struct sockaddr_in)) {
        struct sockaddr_in sin = {};
        bpf_probe_read_user(&sin, sizeof(sin), uaddr);
        pconn.remote_port = bpf_ntohs(sin.sin_port);
        pconn.remote_ip4 = sin.sin_addr.s_addr;
    } else if (sa_family == KW_AF_INET6 && addrlen >= (int)sizeof(struct sockaddr_in6)) {
        struct sockaddr_in6 sin6 = {};
        bpf_probe_read_user(&sin6, sizeof(sin6), uaddr);
        pconn.remote_port = bpf_ntohs(sin6.sin6_port);
        __builtin_memcpy(pconn.remote_ip6, &sin6.sin6_addr, 16);
    }

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    bpf_map_update_elem(&in_flight_connect, &pid_tgid, &pconn, BPF_ANY);
    return 0;
}

SEC("fentry/tcp_v4_connect")
int BPF_PROG(handle_tcp_v4_connect, struct sock *sk, struct sockaddr *uaddr, int addr_len)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg || !sk || !uaddr) return 0;

    struct sockaddr_in sin = {};
    bpf_probe_read_kernel(&sin, sizeof(sin), uaddr);

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u64 uid_gid = bpf_get_current_uid_gid();
    __u64 cookie = derive_sock_cookie(sk);
    __u16 rport = bpf_ntohs(sin.sin_port);
    __u32 rip4 = sin.sin_addr.s_addr;
    __u16 lport = BPF_CORE_READ(sk, __sk_common.skc_num);

    struct watched_sock_ctx wctx = {};
    wctx.cgroup_id = cg;
    wctx.pid = (__u32)(pid_tgid & 0xffffffffULL);
    wctx.tgid = (__u32)(pid_tgid >> 32);
    wctx.uid = (__u32)(uid_gid & 0xffffffffULL);
    wctx.gid = (__u32)(uid_gid >> 32);
    wctx.sock_cookie = cookie;
    wctx.af = KW_AF_INET;
    wctx.proto = KW_IPPROTO_TCP;
    wctx.local_port = lport;
    wctx.remote_port = rport;
    wctx.remote_ip4 = rip4;
    bpf_get_current_comm(wctx.comm, sizeof(wctx.comm));

    __u64 sk_key = (__u64)(unsigned long)sk;
    bpf_map_update_elem(&watched_sockets, &sk_key, &wctx, BPF_ANY);

    struct pending_connect_ctx *pconn = bpf_map_lookup_elem(&in_flight_connect, &pid_tgid);
    if (pconn) {
        pconn->sk_ptr = sk_key;
        pconn->sock_cookie = cookie;
        pconn->af = KW_AF_INET;
        pconn->proto = KW_IPPROTO_TCP;
        pconn->local_port = lport;
        pconn->remote_port = rport;
        pconn->remote_ip4 = rip4;
    }

    struct witness_event *ev = reserve_event_slot(cg, WITNESS_EVENT_NET, WITNESS_NET_CONNECT);
    if (!ev) return 0;
    ev->phase = WITNESS_PHASE_ATTEMPTED;
    ev->outcome = WITNESS_NET_OUTCOME_ATTEMPTED;
    ev->sock_cookie = cookie;
    ev->af = KW_AF_INET;
    ev->proto = KW_IPPROTO_TCP;
    ev->local_port = lport;
    ev->remote_port = rport;
    ev->remote_ip4 = rip4;
    bpf_ringbuf_submit(ev, 0);
    return 0;
}

SEC("fentry/tcp_v6_connect")
int BPF_PROG(handle_tcp_v6_connect, struct sock *sk, struct sockaddr *uaddr, int addr_len)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg || !sk || !uaddr) return 0;

    struct sockaddr_in6 sin6 = {};
    bpf_probe_read_kernel(&sin6, sizeof(sin6), uaddr);

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u64 uid_gid = bpf_get_current_uid_gid();
    __u64 cookie = derive_sock_cookie(sk);
    __u16 rport = bpf_ntohs(sin6.sin6_port);
    __u16 lport = BPF_CORE_READ(sk, __sk_common.skc_num);

    struct watched_sock_ctx wctx = {};
    wctx.cgroup_id = cg;
    wctx.pid = (__u32)(pid_tgid & 0xffffffffULL);
    wctx.tgid = (__u32)(pid_tgid >> 32);
    wctx.uid = (__u32)(uid_gid & 0xffffffffULL);
    wctx.gid = (__u32)(uid_gid >> 32);
    wctx.sock_cookie = cookie;
    wctx.af = KW_AF_INET6;
    wctx.proto = KW_IPPROTO_TCP;
    wctx.local_port = lport;
    wctx.remote_port = rport;
    __builtin_memcpy(wctx.remote_ip6, &sin6.sin6_addr, 16);
    bpf_get_current_comm(wctx.comm, sizeof(wctx.comm));

    __u64 sk_key = (__u64)(unsigned long)sk;
    bpf_map_update_elem(&watched_sockets, &sk_key, &wctx, BPF_ANY);

    struct pending_connect_ctx *pconn = bpf_map_lookup_elem(&in_flight_connect, &pid_tgid);
    if (pconn) {
        pconn->sk_ptr = sk_key;
        pconn->sock_cookie = cookie;
        pconn->af = KW_AF_INET6;
        pconn->proto = KW_IPPROTO_TCP;
        pconn->local_port = lport;
        pconn->remote_port = rport;
        __builtin_memcpy(pconn->remote_ip6, &sin6.sin6_addr, 16);
    }

    struct witness_event *ev = reserve_event_slot(cg, WITNESS_EVENT_NET, WITNESS_NET_CONNECT);
    if (!ev) return 0;
    ev->phase = WITNESS_PHASE_ATTEMPTED;
    ev->outcome = WITNESS_NET_OUTCOME_ATTEMPTED;
    ev->sock_cookie = cookie;
    ev->af = KW_AF_INET6;
    ev->proto = KW_IPPROTO_TCP;
    ev->local_port = lport;
    ev->remote_port = rport;
    __builtin_memcpy(ev->remote_ip6, &sin6.sin6_addr, 16);
    bpf_ringbuf_submit(ev, 0);
    return 0;
}

SEC("tp_btf/inet_sock_set_state")
int BPF_PROG(handle_inet_sock_set_state, const struct sock *sk, const int oldstate, const int newstate)
{
    if (!sk) return 0;
    __u64 sk_key = (__u64)(unsigned long)sk;
    struct watched_sock_ctx *wctx = bpf_map_lookup_elem(&watched_sockets, &sk_key);
    if (!wctx) return 0;

    __u16 lport = BPF_CORE_READ(sk, __sk_common.skc_num);
    if (lport != 0) wctx->local_port = lport;

    int sk_err = BPF_CORE_READ(sk, sk_err);
    __u32 outcome = WITNESS_NET_OUTCOME_IN_PROGRESS;
    if (newstate == 1) { /* TCP_ESTABLISHED */
        outcome = WITNESS_NET_OUTCOME_CONNECTED;
    } else if (newstate == 7) { /* TCP_CLOSE */
        if (oldstate == 2) { /* TCP_SYN_SENT -> TCP_CLOSE */
            if (sk_err == 110) outcome = WITNESS_NET_OUTCOME_TIMED_OUT;
            else if (sk_err == 101 || sk_err == 113) outcome = WITNESS_NET_OUTCOME_UNREACHABLE;
            else outcome = WITNESS_NET_OUTCOME_REFUSED;
        } else {
            outcome = WITNESS_NET_OUTCOME_CONNECTED;
        }
    }

    struct witness_event *ev = reserve_event_slot(
        wctx->cgroup_id, WITNESS_EVENT_NET, WITNESS_NET_STATE_CHANGE);
    if (!ev) return 0;

    ev->pid = wctx->pid;
    ev->tgid = wctx->tgid;
    ev->uid = wctx->uid;
    ev->gid = wctx->gid;
    __builtin_memcpy(ev->comm, wctx->comm, sizeof(ev->comm));
    ev->phase = WITNESS_PHASE_STATE_CHANGE;
    ev->outcome = outcome;
    ev->result_errno = sk_err;
    ev->sock_cookie = wctx->sock_cookie;
    ev->af = wctx->af;
    ev->proto = wctx->proto;
    ev->local_port = wctx->local_port;
    ev->remote_port = wctx->remote_port;
    ev->old_state = (__u8)oldstate;
    ev->new_state = (__u8)newstate;
    ev->remote_ip4 = wctx->remote_ip4;
    __builtin_memcpy(ev->remote_ip6, wctx->remote_ip6, 16);
    bpf_ringbuf_submit(ev, 0);
    return 0;
}

SEC("tp/syscalls/sys_exit_connect")
int handle_sys_exit_connect(struct trace_event_raw_sys_exit *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    struct pending_connect_ctx *pconn = bpf_map_lookup_elem(&in_flight_connect, &pid_tgid);
    if (!pconn) return 0;

    /* If tcp_v4_connect / tcp_v6_connect didn't run (e.g. failed early or non-TCP), emit ATTEMPTED first */
    if (pconn->sk_ptr == 0) {
        struct witness_event *aev = reserve_event_slot(
            pconn->cgroup_id, WITNESS_EVENT_NET, WITNESS_NET_CONNECT);
        if (aev) {
            aev->phase = WITNESS_PHASE_ATTEMPTED;
            aev->outcome = WITNESS_NET_OUTCOME_ATTEMPTED;
            aev->sock_cookie = pconn->sock_cookie;
            aev->af = pconn->af;
            aev->proto = pconn->proto;
            aev->local_port = pconn->local_port;
            aev->remote_port = pconn->remote_port;
            aev->remote_ip4 = pconn->remote_ip4;
            __builtin_memcpy(aev->remote_ip6, pconn->remote_ip6, 16);
            bpf_ringbuf_submit(aev, 0);
        }
    } else {
        struct watched_sock_ctx *wctx = bpf_map_lookup_elem(&watched_sockets, &pconn->sk_ptr);
        if (wctx && wctx->local_port != 0) {
            pconn->local_port = wctx->local_port;
        }
    }

    __s32 err = (ctx->ret < 0) ? (__s32)(-ctx->ret) : 0;
    struct witness_event *ev = reserve_event_slot(
        pconn->cgroup_id, WITNESS_EVENT_NET, WITNESS_NET_CONNECT);
    if (ev) {
        ev->phase = WITNESS_PHASE_COMPLETED;
        ev->outcome = errno_to_net_outcome(err);
        ev->result_errno = err;
        ev->sock_cookie = pconn->sock_cookie;
        ev->af = pconn->af;
        ev->proto = pconn->proto;
        ev->local_port = pconn->local_port;
        ev->remote_port = pconn->remote_port;
        ev->remote_ip4 = pconn->remote_ip4;
        __builtin_memcpy(ev->remote_ip6, pconn->remote_ip6, 16);
        bpf_ringbuf_submit(ev, 0);
    }

    bpf_map_delete_elem(&in_flight_connect, &pid_tgid);
    return 0;
}

static __always_inline void extract_udp_v4_peer(
    struct sock *sk,
    struct msghdr *msg,
    __u32 *rip4_out,
    __u16 *rport_out,
    __u16 *lport_out)
{
    *lport_out = BPF_CORE_READ(sk, __sk_common.skc_num);
    void *msg_name = BPF_CORE_READ(msg, msg_name);
    int msg_namelen = BPF_CORE_READ(msg, msg_namelen);
    if (msg_name && msg_namelen >= (int)sizeof(struct sockaddr_in)) {
        struct sockaddr_in sin = {};
        bpf_probe_read_kernel(&sin, sizeof(sin), msg_name);
        *rip4_out = sin.sin_addr.s_addr;
        *rport_out = bpf_ntohs(sin.sin_port);
    } else {
        *rip4_out = BPF_CORE_READ(sk, __sk_common.skc_daddr);
        *rport_out = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
    }
}

static __always_inline void extract_udp_v6_peer(
    struct sock *sk,
    struct msghdr *msg,
    __u8 *rip6_out,
    __u16 *rport_out,
    __u16 *lport_out)
{
    *lport_out = BPF_CORE_READ(sk, __sk_common.skc_num);
    void *msg_name = BPF_CORE_READ(msg, msg_name);
    int msg_namelen = BPF_CORE_READ(msg, msg_namelen);
    if (msg_name && msg_namelen >= (int)sizeof(struct sockaddr_in6)) {
        struct sockaddr_in6 sin6 = {};
        bpf_probe_read_kernel(&sin6, sizeof(sin6), msg_name);
        __builtin_memcpy(rip6_out, &sin6.sin6_addr, 16);
        *rport_out = bpf_ntohs(sin6.sin6_port);
    } else {
        struct in6_addr daddr = BPF_CORE_READ(sk, __sk_common.skc_v6_daddr);
        __builtin_memcpy(rip6_out, &daddr, 16);
        *rport_out = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
    }
}

SEC("fexit/udp_sendmsg")
int BPF_PROG(handle_udp_sendmsg, struct sock *sk, struct msghdr *msg, size_t len, int ret)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg || !sk || !msg) return 0;

    __u32 rip4 = 0;
    __u16 rport = 0;
    __u16 lport = 0;
    extract_udp_v4_peer(sk, msg, &rip4, &rport, &lport);
    __u64 cookie = derive_sock_cookie(sk);

    struct witness_event *aev = reserve_event_slot(cg, WITNESS_EVENT_NET, WITNESS_NET_SENDMSG);
    if (aev) {
        aev->phase = WITNESS_PHASE_ATTEMPTED;
        aev->outcome = WITNESS_NET_OUTCOME_ATTEMPTED;
        aev->sock_cookie = cookie;
        aev->af = KW_AF_INET;
        aev->proto = KW_IPPROTO_UDP;
        aev->local_port = lport;
        aev->remote_port = rport;
        aev->remote_ip4 = rip4;
        aev->bytes = (__u64)len;
        bpf_ringbuf_submit(aev, 0);
    }

    __s32 err = (ret < 0) ? (__s32)(-ret) : 0;
    struct witness_event *cev = reserve_event_slot(cg, WITNESS_EVENT_NET, WITNESS_NET_SENDMSG);
    if (cev) {
        cev->phase = WITNESS_PHASE_COMPLETED;
        cev->outcome = (ret >= 0) ? WITNESS_NET_OUTCOME_CONNECTED : errno_to_net_outcome(err);
        cev->result_errno = err;
        cev->sock_cookie = cookie;
        cev->af = KW_AF_INET;
        cev->proto = KW_IPPROTO_UDP;
        cev->local_port = lport;
        cev->remote_port = rport;
        cev->remote_ip4 = rip4;
        cev->bytes = (ret >= 0) ? (__u64)ret : 0;
        bpf_ringbuf_submit(cev, 0);
    }
    return 0;
}

SEC("fexit/udpv6_sendmsg")
int BPF_PROG(handle_udpv6_sendmsg, struct sock *sk, struct msghdr *msg, size_t len, int ret)
{
    __u64 cg = resolve_watched_cgroup();
    if (!cg || !sk || !msg) return 0;

    __u8 rip6[16] = {};
    __u16 rport = 0;
    __u16 lport = 0;
    extract_udp_v6_peer(sk, msg, rip6, &rport, &lport);
    __u64 cookie = derive_sock_cookie(sk);

    struct witness_event *aev = reserve_event_slot(cg, WITNESS_EVENT_NET, WITNESS_NET_SENDMSG);
    if (aev) {
        aev->phase = WITNESS_PHASE_ATTEMPTED;
        aev->outcome = WITNESS_NET_OUTCOME_ATTEMPTED;
        aev->sock_cookie = cookie;
        aev->af = KW_AF_INET6;
        aev->proto = KW_IPPROTO_UDP;
        aev->local_port = lport;
        aev->remote_port = rport;
        __builtin_memcpy(aev->remote_ip6, rip6, 16);
        aev->bytes = (__u64)len;
        bpf_ringbuf_submit(aev, 0);
    }

    __s32 err = (ret < 0) ? (__s32)(-ret) : 0;
    struct witness_event *cev = reserve_event_slot(cg, WITNESS_EVENT_NET, WITNESS_NET_SENDMSG);
    if (cev) {
        cev->phase = WITNESS_PHASE_COMPLETED;
        cev->outcome = (ret >= 0) ? WITNESS_NET_OUTCOME_CONNECTED : errno_to_net_outcome(err);
        cev->result_errno = err;
        cev->sock_cookie = cookie;
        cev->af = KW_AF_INET6;
        cev->proto = KW_IPPROTO_UDP;
        cev->local_port = lport;
        cev->remote_port = rport;
        __builtin_memcpy(cev->remote_ip6, rip6, 16);
        cev->bytes = (ret >= 0) ? (__u64)ret : 0;
        bpf_ringbuf_submit(cev, 0);
    }
    return 0;
}
