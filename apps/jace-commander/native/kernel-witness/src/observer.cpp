#include "witness/observer.hpp"
#include "witness_event.h"

#include <bpf/bpf.h>
#include <bpf/libbpf.h>

#include <algorithm>
#include <cerrno>
#include <cstring>

namespace jc::witness {

namespace {

int libbpf_silent_print(enum libbpf_print_level /*level*/, const char* /*format*/, va_list /*args*/) {
    return 0;
}

ObservedEvent from_raw_event(const struct witness_event& raw) {
    ObservedEvent ev;
    ev.seq = raw.seq;
    ev.timestamp_ns = raw.timestamp_ns;
    ev.cgroup_id = raw.cgroup_id;
    switch (raw.event_type) {
        case WITNESS_EVENT_FORK: ev.event_type = EventType::Fork; break;
        case WITNESS_EVENT_EXEC: ev.event_type = EventType::Exec; break;
        case WITNESS_EVENT_EXIT: ev.event_type = EventType::Exit; break;
        default: ev.event_type = EventType::Exec; break;
    }
    ev.pid = raw.pid;
    ev.tgid = raw.tgid;
    ev.ppid = raw.ppid;
    ev.child_pid = raw.child_pid;
    ev.child_tgid = raw.child_tgid;
    ev.uid = raw.uid;
    ev.gid = raw.gid;
    ev.exit_code = raw.exit_code;
    size_t comm_len = strnlen(raw.comm, JC_WITNESS_COMM_LEN);
    ev.comm.assign(raw.comm, comm_len);
    return ev;
}

} // namespace

BpfCheckResult check_bpf_object(const std::string& bpf_obj_path) {
    BpfCheckResult res;
    libbpf_set_print(libbpf_silent_print);

    struct bpf_object* obj = bpf_object__open_file(bpf_obj_path.c_str(), nullptr);
    long err = libbpf_get_error(obj);
    if (!obj || err != 0) {
        res.error = "bpf_object__open_file failed: " + std::string(std::strerror(static_cast<int>(-err)));
        return res;
    }

    struct bpf_program* prog = nullptr;
    bpf_object__for_each_program(prog, obj) {
        const char* name = bpf_program__name(prog);
        if (name) res.programs.emplace_back(name);
    }

    struct bpf_map* map = nullptr;
    bpf_object__for_each_map(map, obj) {
        const char* name = bpf_map__name(map);
        if (name) res.maps.emplace_back(name);
    }

    bpf_object__close(obj);

    auto has = [](const std::vector<std::string>& v, const std::string& target) {
        return std::find(v.begin(), v.end(), target) != v.end();
    };

    if (!has(res.programs, "handle_sched_process_fork") ||
        !has(res.programs, "handle_sched_process_exec") ||
        !has(res.programs, "handle_sched_process_exit")) {
        res.error = "missing required tracepoint BPF programs";
        return res;
    }
    if (!has(res.maps, "watched_cgroups") ||
        !has(res.maps, "events") ||
        !has(res.maps, "stats_map")) {
        res.error = "missing required BPF maps (watched_cgroups, events, stats_map)";
        return res;
    }

    res.valid = true;
    return res;
}

struct LiveBpfObserver::Impl {
    struct bpf_object* obj{nullptr};
    std::vector<struct bpf_link*> links;
    struct ring_buffer* rb{nullptr};
    int watched_fd{-1};
    int stats_fd{-1};

    ~Impl() {
        if (rb) {
            ring_buffer__free(rb);
            rb = nullptr;
        }
        for (auto* link : links) {
            if (link) bpf_link__destroy(link);
        }
        links.clear();
        if (obj) {
            bpf_object__close(obj);
            obj = nullptr;
        }
    }
};

LiveBpfObserver::LiveBpfObserver(LiveObserverConfig cfg)
    : impl_(std::make_unique<Impl>()), cfg_(std::move(cfg)) {}

LiveBpfObserver::~LiveBpfObserver() = default;

bool LiveBpfObserver::start(std::string& error) {
    libbpf_set_print(libbpf_silent_print);

    impl_->obj = bpf_object__open_file(cfg_.bpf_obj_path.c_str(), nullptr);
    long err = libbpf_get_error(impl_->obj);
    if (!impl_->obj || err != 0) {
        error = "bpf_object__open_file failed: " + std::string(std::strerror(static_cast<int>(-err)));
        impl_->obj = nullptr;
        return false;
    }

    int load_rc = bpf_object__load(impl_->obj);
    if (load_rc != 0) {
        error = "bpf_object__load failed (unsupported kernel or missing CAP_BPF/CAP_PERFMON): " +
                std::string(std::strerror(-load_rc));
        return false;
    }

    struct bpf_map* watched_map = bpf_object__find_map_by_name(impl_->obj, "watched_cgroups");
    struct bpf_map* events_map = bpf_object__find_map_by_name(impl_->obj, "events");
    struct bpf_map* stats_map = bpf_object__find_map_by_name(impl_->obj, "stats_map");
    if (!watched_map || !events_map || !stats_map) {
        error = "required BPF maps not found in object";
        return false;
    }

    impl_->watched_fd = bpf_map__fd(watched_map);
    impl_->stats_fd = bpf_map__fd(stats_map);
    int events_fd = bpf_map__fd(events_map);

    if (bpf_map_update_elem(impl_->watched_fd, &cfg_.cgroup_id, &cfg_.invocation_tag, BPF_ANY) != 0) {
        error = "failed to register cgroup_id in watched_cgroups: " + std::string(std::strerror(errno));
        return false;
    }

    struct bpf_program* prog = nullptr;
    bpf_object__for_each_program(prog, impl_->obj) {
        struct bpf_link* link = bpf_program__attach(prog);
        long link_err = libbpf_get_error(link);
        if (!link || link_err != 0) {
            error = "bpf_program__attach failed: " + std::string(std::strerror(static_cast<int>(-link_err)));
            return false;
        }
        impl_->links.push_back(link);
    }

    auto rb_cb = [](void* ctx, void* data, size_t size) -> int {
        auto* self = static_cast<LiveBpfObserver*>(ctx);
        if (size < sizeof(struct witness_event)) {
            self->ringbuf_error_ = true;
            return 0;
        }
        struct witness_event raw{};
        std::memcpy(&raw, data, sizeof(raw));
        self->events_.push_back(from_raw_event(raw));
        return 0;
    };

    impl_->rb = ring_buffer__new(events_fd, rb_cb, this, nullptr);
    if (!impl_->rb) {
        error = "ring_buffer__new failed: " + std::string(std::strerror(errno));
        return false;
    }

    return true;
}

void LiveBpfObserver::poll(int timeout_ms) {
    if (!impl_->rb) return;
    int rc = ring_buffer__poll(impl_->rb, timeout_ms);
    if (rc < 0 && errno != EINTR) {
        ringbuf_error_ = true;
    }
}

void LiveBpfObserver::stop_and_drain(uint64_t& dropped_events_out) {
    dropped_events_out = 0;
    if (impl_->rb) {
        // Drain any remaining buffered events
        for (int i = 0; i < 10; ++i) {
            int n = ring_buffer__consume(impl_->rb);
            if (n <= 0) break;
        }
    }
    if (impl_->stats_fd >= 0) {
        uint32_t key = 0;
        struct witness_stats stats{};
        if (bpf_map_lookup_elem(impl_->stats_fd, &key, &stats) == 0) {
            dropped_events_out = stats.dropped_events;
        }
    }
    if (impl_->watched_fd >= 0) {
        bpf_map_delete_elem(impl_->watched_fd, &cfg_.cgroup_id);
    }
    impl_.reset();
}

} // namespace jc::witness
