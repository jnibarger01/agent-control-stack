#pragma once

#include "witness/canonical_json.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace jc::witness {

enum class EventType {
    Fork = 1,
    Exec = 2,
    Exit = 3,
};

struct ObservedEvent {
    uint64_t seq{0};
    uint64_t timestamp_ns{0};
    uint64_t cgroup_id{0};
    EventType event_type{EventType::Exec};
    uint32_t pid{0};
    uint32_t tgid{0};
    uint32_t ppid{0};
    uint32_t child_pid{0};
    uint32_t child_tgid{0};
    uint32_t uid{0};
    uint32_t gid{0};
    int32_t exit_code{0};
    std::string comm;
};

struct ProcessNode {
    uint32_t pid{0};
    uint32_t tgid{0};
    uint32_t ppid{0};
    std::string comm;
    uint32_t uid{0};
    uint32_t gid{0};
    uint64_t forked_at_ns{0};
    uint64_t execed_at_ns{0};
    uint64_t exited_at_ns{0};
    int32_t exit_code{0};
    std::vector<ProcessNode> children;
};

struct EventCounts {
    uint64_t total{0};
    uint64_t fork{0};
    uint64_t exec{0};
    uint64_t exit{0};
};

struct ReconstructionResult {
    std::vector<ObservedEvent> events;
    std::vector<ProcessNode> process_tree;
    EventCounts counts;
    uint64_t sequence_gaps{0};
    uint64_t excluded_unrelated_cgroup_events{0};
    uint64_t start_time_ns{0};
    uint64_t end_time_ns{0};
    std::vector<std::string> anomalies;
};

std::string event_type_to_string(EventType t);
EventType event_type_from_string(std::string_view s);

JsonValue observed_event_to_json(const ObservedEvent& ev);
ObservedEvent observed_event_from_json(const JsonValue& v);
JsonValue process_node_to_json(const ProcessNode& node);

std::vector<ObservedEvent> parse_events_jsonl(std::string_view jsonl, std::vector<std::string>& errors);

ReconstructionResult reconstruct_process_tree(
    const std::vector<ObservedEvent>& raw_events,
    uint64_t target_cgroup_id);

} // namespace jc::witness
