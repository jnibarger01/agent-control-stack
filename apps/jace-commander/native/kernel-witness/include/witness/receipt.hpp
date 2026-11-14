#pragma once

#include "witness/canonical_json.hpp"
#include "witness/process_tree.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace jc::witness {

inline constexpr const char* kReceiptSchemaVersionV1 = "jc.kernel-witness.receipt.v1";
inline constexpr const char* kReceiptSchemaVersionV2 = "jc.kernel-witness.receipt.v2";
inline constexpr const char* kReceiptSchemaVersion = kReceiptSchemaVersionV2;
inline constexpr const char* kObserverVersion = "0.2.0";

struct ObservationReceipt {
    std::string schema_version{kReceiptSchemaVersionV2};
    std::string observer_version{kObserverVersion};
    std::string observer_mode{"live"}; // "live" | "synthetic" | "replay"
    std::string observer_id;
    std::string work_item_id;
    std::string attempt_id;
    std::string lease_id;
    std::string invocation_hash;
    uint64_t cgroup_id{0};
    std::string cgroup_path;
    uint32_t root_pid{0};
    uint64_t start_time_ns{0};
    uint64_t end_time_ns{0};
    std::string signed_at_utc;
    std::string status{"complete"}; // "complete" | "incomplete" | "failed"
    std::vector<std::string> incomplete_reasons;
    ObservationScope observation_scope;
    CategoryCompleteness category_completeness;
    std::vector<ObservedEvent> events;
    std::vector<ProcessNode> process_tree;
    std::vector<FilesystemEvent> filesystem_events;
    std::vector<NetworkEvent> network_events;
    EventCounts event_counts;
    uint64_t dropped_events{0};
    uint64_t sequence_gaps{0};
    std::optional<std::string> previous_evidence_hash;
    std::optional<std::string> acs_anchor_ref;
    std::string signing_key_id;
    std::string evidence_hash;
    std::string signature;
};

JsonValue receipt_body_to_json(const ObservationReceipt& r);
JsonValue receipt_to_json(const ObservationReceipt& r);

void populate_receipt_completeness_digests(ObservationReceipt& r);

void finalize_and_sign_receipt(
    ObservationReceipt& r,
    const std::string& private_pem_or_path,
    bool is_path = true);

struct VerificationOptions {
    std::string work_item_id;
    std::string attempt_id;
    std::string lease_id;
    std::string invocation_hash;
    std::string previous_evidence_hash;
    std::string seen_hashes_file;
    std::string key_manifest_path;
    std::vector<std::string> required_categories;
    uint32_t expected_root_pid{0};
    bool require_live{false};
    bool require_v2{false};
    bool allow_partial_categories{false};
};

struct VerificationResult {
    bool valid{false};
    std::vector<std::string> reasons;
    std::string evidence_hash;
    std::string schema_version;
    std::string signing_key_id;
};

VerificationResult verify_receipt(
    const JsonValue& receipt_json,
    const std::string& public_pem_or_path,
    const VerificationOptions& opts,
    bool is_path = true);

} // namespace jc::witness
