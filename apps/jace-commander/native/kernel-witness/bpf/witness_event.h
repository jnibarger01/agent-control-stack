#ifndef JC_KERNEL_WITNESS_EVENT_H
#define JC_KERNEL_WITNESS_EVENT_H

#ifndef __VMLINUX_H__
#include <stdint.h>
typedef uint8_t  kw_u8;
typedef uint16_t kw_u16;
typedef uint32_t kw_u32;
typedef int32_t  kw_s32;
typedef uint64_t kw_u64;
typedef int64_t  kw_s64;
#else
typedef __u8  kw_u8;
typedef __u16 kw_u16;
typedef __u32 kw_u32;
typedef __s32 kw_s32;
typedef __u64 kw_u64;
typedef __s64 kw_s64;
#endif

#define JC_WITNESS_COMM_LEN 16
#define JC_WITNESS_PATH_LEN 128

enum witness_event_type {
    WITNESS_EVENT_FORK = 1,
    WITNESS_EVENT_EXEC = 2,
    WITNESS_EVENT_EXIT = 3,
    WITNESS_EVENT_FS   = 4,
    WITNESS_EVENT_NET  = 5,
};

enum witness_fs_op {
    WITNESS_FS_OPENAT     = 1,
    WITNESS_FS_CREATE     = 2,
    WITNESS_FS_MODIFY     = 3,
    WITNESS_FS_TRUNCATE   = 4,
    WITNESS_FS_DELETE     = 5,
    WITNESS_FS_RENAME     = 6,
    WITNESS_FS_MKDIR      = 7,
    WITNESS_FS_RMDIR      = 8,
    WITNESS_FS_MMAP_WRITE = 9,
    WITNESS_FS_IO_URING   = 10,
};

enum witness_phase {
    WITNESS_PHASE_ATTEMPTED    = 1,
    WITNESS_PHASE_COMPLETED    = 2,
    WITNESS_PHASE_STATE_CHANGE = 3,
};

enum witness_net_op {
    WITNESS_NET_CONNECT      = 1,
    WITNESS_NET_SENDMSG      = 2,
    WITNESS_NET_STATE_CHANGE = 3,
};

enum witness_net_outcome {
    WITNESS_NET_OUTCOME_ATTEMPTED   = 1,
    WITNESS_NET_OUTCOME_CONNECTED   = 2,
    WITNESS_NET_OUTCOME_REFUSED     = 3,
    WITNESS_NET_OUTCOME_TIMED_OUT   = 4,
    WITNESS_NET_OUTCOME_UNREACHABLE = 5,
    WITNESS_NET_OUTCOME_IN_PROGRESS = 6,
    WITNESS_NET_OUTCOME_FAILED      = 7,
    WITNESS_NET_OUTCOME_INCOMPLETE  = 8,
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
    kw_u32 op;
    kw_u32 phase;
    kw_s32 result_errno;
    kw_u64 bytes;
    kw_u64 flags;
    kw_u64 dev;
    kw_u64 inode;
    kw_u64 target_inode;
    kw_u32 mount_id;
    kw_u32 outcome;
    kw_u64 sock_cookie;
    kw_u16 af;
    kw_u16 proto;
    kw_u16 local_port;
    kw_u16 remote_port;
    kw_u8  old_state;
    kw_u8  new_state;
    kw_u16 reserved_pad;
    kw_u32 remote_ip4;
    kw_u8  remote_ip6[16];
    char   comm[JC_WITNESS_COMM_LEN];
    char   path[JC_WITNESS_PATH_LEN];
    char   target_path[JC_WITNESS_PATH_LEN];
};

struct witness_stats {
    kw_u64 seq_counter;
    kw_u64 total_events;
    kw_u64 dropped_events;
    kw_u64 process_events;
    kw_u64 fs_events;
    kw_u64 net_events;
    kw_u64 process_drops;
    kw_u64 fs_drops;
    kw_u64 net_drops;
    kw_u64 mmap_write_events;
    kw_u64 io_uring_events;
};

#endif /* JC_KERNEL_WITNESS_EVENT_H */
