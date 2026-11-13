#ifndef JC_KERNEL_WITNESS_EVENT_H
#define JC_KERNEL_WITNESS_EVENT_H

#ifndef __VMLINUX_H__
#include <stdint.h>
typedef uint8_t  kw_u8;
typedef uint32_t kw_u32;
typedef int32_t  kw_s32;
typedef uint64_t kw_u64;
#else
typedef __u8  kw_u8;
typedef __u32 kw_u32;
typedef __s32 kw_s32;
typedef __u64 kw_u64;
#endif

#define JC_WITNESS_COMM_LEN 16

enum witness_event_type {
    WITNESS_EVENT_FORK = 1,
    WITNESS_EVENT_EXEC = 2,
    WITNESS_EVENT_EXIT = 3,
};

struct witness_event {
    kw_u64 seq;
    kw_u64 timestamp_ns;
    kw_u64 cgroup_id;
    kw_u32 event_type;
    kw_u32 pid;
    kw_u32 tgid;
    kw_u32 ppid;
    kw_u32 child_pid;
    kw_u32 child_tgid;
    kw_u32 uid;
    kw_u32 gid;
    kw_s32 exit_code;
    char comm[JC_WITNESS_COMM_LEN];
};

struct witness_stats {
    kw_u64 seq_counter;
    kw_u64 total_events;
    kw_u64 dropped_events;
};

#endif /* JC_KERNEL_WITNESS_EVENT_H */
