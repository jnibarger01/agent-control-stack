#pragma once

#include "witness/process_tree.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace jc::witness {

struct BpfCheckResult {
    bool valid{false};
    std::vector<std::string> programs;
    std::vector<std::string> maps;
    std::string error;
};

BpfCheckResult check_bpf_object(const std::string& bpf_obj_path);

struct LiveObserverConfig {
    std::string bpf_obj_path;
    uint64_t cgroup_id{0};
    uint64_t invocation_tag{1};
};

struct LiveObserverStats {
    uint64_t total_events{0};
    uint64_t dropped_events{0};
    uint64_t process_events{0};
    uint64_t fs_events{0};
    uint64_t net_events{0};
    uint64_t process_drops{0};
    uint64_t fs_drops{0};
    uint64_t net_drops{0};
    uint64_t mmap_write_events{0};
    uint64_t io_uring_events{0};
};

class LiveBpfObserver {
public:
    explicit LiveBpfObserver(LiveObserverConfig cfg);
    ~LiveBpfObserver();

    LiveBpfObserver(const LiveBpfObserver&) = delete;
    LiveBpfObserver& operator=(const LiveBpfObserver&) = delete;

    bool start(std::string& error);
    void poll(int timeout_ms);
    void stop_and_drain(uint64_t& dropped_events_out);

    const std::vector<ObservedEvent>& events() const { return events_; }
    const LiveObserverStats& stats() const { return stats_; }
    const std::vector<std::string>& attach_warnings() const { return attach_warnings_; }
    bool ringbuf_error() const { return ringbuf_error_; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    LiveObserverConfig cfg_;
    std::vector<ObservedEvent> events_;
    LiveObserverStats stats_{};
    std::vector<std::string> attach_warnings_;
    bool ringbuf_error_{false};
};

} // namespace jc::witness
