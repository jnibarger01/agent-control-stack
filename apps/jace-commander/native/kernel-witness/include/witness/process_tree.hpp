#pragma once

#include "witness/canonical_json.hpp"

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace jc::witness {

enum class EventType {
    Fork = 1,
    Exec = 2,
    Exit = 3,
    Fs   = 4,
    Net  = 5,
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

    // Extended fields for Phase 4 (FS) and Phase 5 (NET) raw events
    uint32_t op{0};
    uint32_t phase{0};
    int32_t result_errno{0};
    uint64_t bytes{0};
    uint64_t flags{0};
    uint64_t dev{0};
    uint64_t inode{0};
    uint64_t target_inode{0};
    uint32_t mount_id{0};
    uint32_t outcome{0};
    uint64_t sock_cookie{0};
    uint16_t af{0};
    uint16_t proto{0};
    uint16_t local_port{0};
    uint16_t remote_port{0};
    uint8_t old_state{0};
    uint8_t new_state{0};
    uint32_t remote_ip4{0};
    std::array<uint8_t, 16> remote_ip6{};
    std::string path;
    std::string target_path;
    std::string remote_addr_override;
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

struct FilesystemEvent {
    uint64_t seq{0};
    uint64_t timestamp_ns{0};
    uint64_t cgroup_id{0};
    uint32_t pid{0};
    uint32_t tgid{0};
    std::string comm;
    uint32_t uid{0};
    uint32_t gid{0};
    std::string op;    // CREATE|MODIFY|DELETE|RENAME|TRUNCATE|MKDIR|RMDIR|OPENAT|MMAP_WRITE|IO_URING
    std::string phase; // attempted|completed
    bool succeeded{false};
    int32_t result_errno{0};
    uint64_t bytes{0};
    uint64_t flags{0};
    uint64_t dev{0};
    uint64_t inode{0};
    uint32_t mount_id{0};
    std::string path_digest;
    std::string path_digest_key_id;
    std::optional<std::string> display_path;
    std::optional<std::string> target_path_digest;
    std::optional<std::string> target_display_path;
    uint64_t target_inode{0};
};

struct NetworkEvent {
    uint64_t seq{0};
    uint64_t timestamp_ns{0};
    uint64_t cgroup_id{0};
    uint32_t pid{0};
    uint32_t tgid{0};
    std::string comm;
    uint64_t sock_cookie{0};
    std::string af;    // INET|INET6
    std::string proto; // TCP|UDP
    std::string op;    // CONNECT|SENDMSG|STATE_CHANGE
    std::string phase; // attempted|completed|state_change
    std::optional<std::string> state_transition;
    std::string outcome; // attempted|connected|refused|timed_out|unreachable|in_progress|failed|incomplete
    int32_t errno_val{0};
    std::string remote_addr_digest;
    std::optional<std::string> display_remote_addr;
    uint16_t remote_port{0};
    uint16_t local_port{0};
    uint64_t bytes{0};
};

struct EventCounts {
    uint64_t total{0};
    uint64_t fork{0};
    uint64_t exec{0};
    uint64_t exit{0};
    uint64_t filesystem{0};
    uint64_t network{0};
};

struct ObservationScope {
    std::vector<std::string> policy_required{"process", "filesystem", "network"};
    std::vector<std::string> requested{"process", "filesystem", "network"};
    std::vector<std::string> active{"process", "filesystem", "network"};
};

struct CategoryStatus {
    std::string category; // "process" | "filesystem" | "network"
    bool enabled{true};
    std::string status{"complete"}; // "complete" | "partial" | "incomplete" | "unsupported" | "failed"
    uint64_t event_count{0};
    uint64_t dropped_events{0};
    uint64_t sequence_gaps{0};
    std::optional<uint64_t> first_seq;
    std::optional<uint64_t> last_seq;
    std::string category_digest_sha256;
    std::vector<std::string> incomplete_reasons;
    std::vector<std::string> unsupported_operations;
};

struct CategoryCompleteness {
    CategoryStatus process{"process", true, "complete", 0, 0, 0, std::nullopt, std::nullopt, "", {}, {}};
    CategoryStatus filesystem{"filesystem", true, "complete", 0, 0, 0, std::nullopt, std::nullopt, "", {}, {}};
    CategoryStatus network{"network", true, "complete", 0, 0, 0, std::nullopt, std::nullopt, "", {}, {}};
};

struct ReconstructionOptions {
    std::string hmac_key{"jc-witness-default-path-hmac-key-v2"};
    std::string hmac_key_id;
    bool include_display_paths{false};
    bool include_display_remote_addrs{false};
};

struct ReconstructionResult {
    std::vector<ObservedEvent> events;
    std::vector<ProcessNode> process_tree;
    std::vector<FilesystemEvent> filesystem_events;
    std::vector<NetworkEvent> network_events;
    EventCounts counts;
    CategoryCompleteness category_completeness;
    uint64_t sequence_gaps{0};
    uint64_t excluded_unrelated_cgroup_events{0};
    uint64_t start_time_ns{0};
    uint64_t end_time_ns{0};
    uint32_t root_pid{0};
    std::vector<std::string> anomalies;
};

std::string event_type_to_string(EventType t);
EventType event_type_from_string(std::string_view s);

std::string fs_op_to_string(uint32_t op);
uint32_t fs_op_from_string(std::string_view s);
std::string phase_to_string(uint32_t phase);
uint32_t phase_from_string(std::string_view s);
std::string net_op_to_string(uint32_t op);
uint32_t net_op_from_string(std::string_view s);
std::string net_outcome_to_string(uint32_t outcome);
uint32_t net_outcome_from_string(std::string_view s);
std::string tcp_state_to_string(uint8_t st);

JsonValue observed_event_to_json(const ObservedEvent& ev);
ObservedEvent observed_event_from_json(const JsonValue& v);
JsonValue process_node_to_json(const ProcessNode& node);
JsonValue filesystem_event_to_json(const FilesystemEvent& ev);
FilesystemEvent filesystem_event_from_json(const JsonValue& v);
JsonValue network_event_to_json(const NetworkEvent& ev);
NetworkEvent network_event_from_json(const JsonValue& v);
JsonValue observation_scope_to_json(const ObservationScope& scope);
JsonValue category_status_to_json(const CategoryStatus& st);
JsonValue category_completeness_to_json(const CategoryCompleteness& cc);

std::string compute_process_category_digest(const std::vector<ProcessNode>& tree);
std::string compute_filesystem_category_digest(const std::vector<FilesystemEvent>& fs_events);
std::string compute_network_category_digest(const std::vector<NetworkEvent>& net_events);

std::vector<ObservedEvent> parse_events_jsonl(std::string_view jsonl, std::vector<std::string>& errors);

ReconstructionResult reconstruct_process_tree(
    const std::vector<ObservedEvent>& raw_events,
    uint64_t target_cgroup_id,
    uint32_t root_pid = 0,
    const ReconstructionOptions& opts = {});

} // namespace jc::witness
