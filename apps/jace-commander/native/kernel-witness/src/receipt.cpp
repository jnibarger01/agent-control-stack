#include "witness/receipt.hpp"
#include "witness/crypto.hpp"

#include <fstream>
#include <stdexcept>

namespace jc::witness {

JsonValue receipt_body_to_json(const ObservationReceipt& r) {
    JsonObject obj;
    obj["schemaVersion"] = r.schema_version;
    obj["observerVersion"] = r.observer_version;
    obj["observerMode"] = r.observer_mode;
    obj["observerId"] = r.observer_id;
    obj["workItemId"] = r.work_item_id;
    obj["attemptId"] = r.attempt_id;
    obj["leaseId"] = r.lease_id;
    obj["invocationHash"] = r.invocation_hash;
    obj["cgroupId"] = r.cgroup_id;
    obj["cgroupPath"] = r.cgroup_path;
    obj["rootPid"] = static_cast<uint64_t>(r.root_pid);
    obj["startTimeNs"] = r.start_time_ns;
    obj["endTimeNs"] = r.end_time_ns;
    obj["status"] = r.status;

    JsonArray reasons;
    reasons.reserve(r.incomplete_reasons.size());
    for (const auto& reason : r.incomplete_reasons) {
        reasons.emplace_back(reason);
    }
    obj["incompleteReasons"] = JsonValue(std::move(reasons));

    JsonArray events_arr;
    events_arr.reserve(r.events.size());
    for (const auto& ev : r.events) {
        events_arr.push_back(observed_event_to_json(ev));
    }
    obj["events"] = JsonValue(std::move(events_arr));

    JsonArray tree_arr;
    tree_arr.reserve(r.process_tree.size());
    for (const auto& node : r.process_tree) {
        tree_arr.push_back(process_node_to_json(node));
    }
    obj["processTree"] = JsonValue(std::move(tree_arr));

    JsonObject counts_obj;
    counts_obj["total"] = r.event_counts.total;
    counts_obj["fork"] = r.event_counts.fork;
    counts_obj["exec"] = r.event_counts.exec;
    counts_obj["exit"] = r.event_counts.exit;
    obj["eventCounts"] = JsonValue(std::move(counts_obj));

    obj["droppedEvents"] = r.dropped_events;
    obj["sequenceGaps"] = r.sequence_gaps;
    obj["previousEvidenceHash"] = r.previous_evidence_hash.has_value()
        ? JsonValue(*r.previous_evidence_hash)
        : JsonValue(nullptr);
    obj["acsAnchorRef"] = r.acs_anchor_ref.has_value()
        ? JsonValue(*r.acs_anchor_ref)
        : JsonValue(nullptr);
    obj["signingKeyId"] = r.signing_key_id;

    return JsonValue(std::move(obj));
}

JsonValue receipt_to_json(const ObservationReceipt& r) {
    JsonValue body = receipt_body_to_json(r);
    auto& obj = body.as_object_mut();
    obj["evidenceHash"] = r.evidence_hash;
    obj["signature"] = r.signature;
    return body;
}

void finalize_and_sign_receipt(
    ObservationReceipt& r,
    const std::string& private_pem_or_path,
    bool is_path)
{
    if (r.signing_key_id.empty()) {
        r.signing_key_id = derive_key_id_from_private_pem(private_pem_or_path, is_path);
    }
    JsonValue body = receipt_body_to_json(r);
    std::string canonical_body = serialize_canonical_json(body);
    r.evidence_hash = sha256_hex(canonical_body);
    r.signature = ed25519_sign_pem(canonical_body, private_pem_or_path, is_path);
}

namespace {

bool check_replay_seen(const std::string& file_path, const std::string& hash) {
    std::ifstream ifs(file_path);
    if (!ifs) return false;
    std::string line;
    while (std::getline(ifs, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) {
            line.pop_back();
        }
        if (line == hash) return true;
    }
    return false;
}

void record_replay_seen(const std::string& file_path, const std::string& hash) {
    std::ofstream ofs(file_path, std::ios::app);
    if (!ofs) {
        throw std::runtime_error("failed to append to seen_hashes_file: " + file_path);
    }
    ofs << hash << "\n";
}

std::string get_opt_string(const JsonObject& obj, const std::string& key) {
    auto it = obj.find(key);
    if (it == obj.end() || it->second.is_null()) return "";
    if (!it->second.is_string()) return "";
    return it->second.as_string();
}

} // namespace

VerificationResult verify_receipt(
    const JsonValue& receipt_json,
    const std::string& public_pem_or_path,
    const VerificationOptions& opts,
    bool is_path)
{
    VerificationResult res;
    if (!receipt_json.is_object()) {
        res.reasons.push_back("receipt_not_json_object");
        return res;
    }

    const auto& obj = receipt_json.as_object();

    auto schema_it = obj.find("schemaVersion");
    if (schema_it == obj.end() || !schema_it->second.is_string() ||
        schema_it->second.as_string() != kReceiptSchemaVersion) {
        res.reasons.push_back("invalid_schema_version");
    }

    auto status_it = obj.find("status");
    if (status_it == obj.end() || !status_it->second.is_string()) {
        res.reasons.push_back("missing_status");
    } else if (status_it->second.as_string() != "complete") {
        res.reasons.push_back("incomplete_observation_status:" + status_it->second.as_string());
    }

    auto reasons_it = obj.find("incompleteReasons");
    if (reasons_it == obj.end() || !reasons_it->second.is_array()) {
        res.reasons.push_back("missing_incomplete_reasons");
    } else if (!reasons_it->second.as_array().empty()) {
        res.reasons.push_back("non_empty_incomplete_reasons");
    }

    auto dropped_it = obj.find("droppedEvents");
    if (dropped_it == obj.end() || !dropped_it->second.is_number() || dropped_it->second.as_uint64() != 0) {
        res.reasons.push_back("dropped_events_nonzero");
    }

    auto gaps_it = obj.find("sequenceGaps");
    if (gaps_it == obj.end() || !gaps_it->second.is_number() || gaps_it->second.as_uint64() != 0) {
        res.reasons.push_back("sequence_gaps_nonzero");
    }

    if (opts.require_live) {
        if (get_opt_string(obj, "observerMode") != "live") {
            res.reasons.push_back("observer_mode_not_live");
        }
    }

    auto root_pid_it = obj.find("rootPid");
    uint64_t receipt_root_pid = 0;
    if (root_pid_it != obj.end() && root_pid_it->second.is_number()) {
        receipt_root_pid = root_pid_it->second.as_uint64();
    }
    if (opts.expected_root_pid != 0 && receipt_root_pid != opts.expected_root_pid) {
        res.reasons.push_back("mismatched_root_pid");
    }
    if (receipt_root_pid != 0) {
        auto tree_it = obj.find("processTree");
        if (tree_it != obj.end() && tree_it->second.is_array() && !tree_it->second.as_array().empty()) {
            bool found_root = false;
            for (const auto& node_val : tree_it->second.as_array()) {
                if (node_val.is_object()) {
                    const auto& nobj = node_val.as_object();
                    auto tgid_it = nobj.find("tgid");
                    auto pid_it = nobj.find("pid");
                    uint64_t tgid = (tgid_it != nobj.end() && tgid_it->second.is_number()) ? tgid_it->second.as_uint64() : 0;
                    uint64_t pid = (pid_it != nobj.end() && pid_it->second.is_number()) ? pid_it->second.as_uint64() : 0;
                    if (tgid == receipt_root_pid || pid == receipt_root_pid) {
                        found_root = true;
                        break;
                    }
                }
            }
            if (!found_root) {
                res.reasons.push_back("root_pid_missing_from_process_tree");
            }
        }
    }

    // Correlation checks
    if (!opts.work_item_id.empty() && get_opt_string(obj, "workItemId") != opts.work_item_id) {
        res.reasons.push_back("mismatched_work_item_id");
    }
    if (!opts.attempt_id.empty() && get_opt_string(obj, "attemptId") != opts.attempt_id) {
        res.reasons.push_back("mismatched_attempt_id");
    }
    if (!opts.lease_id.empty() && get_opt_string(obj, "leaseId") != opts.lease_id) {
        res.reasons.push_back("mismatched_lease_id");
    }
    if (!opts.invocation_hash.empty() && get_opt_string(obj, "invocationHash") != opts.invocation_hash) {
        res.reasons.push_back("mismatched_invocation_hash");
    }
    if (!opts.previous_evidence_hash.empty() &&
        get_opt_string(obj, "previousEvidenceHash") != opts.previous_evidence_hash) {
        res.reasons.push_back("mismatched_previous_evidence_hash");
    }

    // Recompute canonical body hash & verify Ed25519 signature
    std::string claimed_hash = get_opt_string(obj, "evidenceHash");
    std::string sig_b64 = get_opt_string(obj, "signature");
    if (claimed_hash.empty()) res.reasons.push_back("missing_evidence_hash");
    if (sig_b64.empty()) res.reasons.push_back("missing_signature");

    JsonObject body_obj = obj;
    body_obj.erase("evidenceHash");
    body_obj.erase("signature");

    std::string canonical_body;
    try {
        canonical_body = serialize_canonical_json(JsonValue(std::move(body_obj)));
    } catch (const std::exception& ex) {
        res.reasons.push_back(std::string("canonicalization_failed:") + ex.what());
        return res;
    }

    std::string computed_hash = sha256_hex(canonical_body);
    res.evidence_hash = computed_hash;

    if (!claimed_hash.empty() && computed_hash != claimed_hash) {
        res.reasons.push_back("tampered_receipt_hash_mismatch");
    }

    if (!sig_b64.empty()) {
        try {
            if (!ed25519_verify_pem(canonical_body, sig_b64, public_pem_or_path, is_path)) {
                res.reasons.push_back("invalid_ed25519_signature");
            }
        } catch (const std::exception& ex) {
            res.reasons.push_back(std::string("signature_verification_error:") + ex.what());
        }
    }

    if (!opts.seen_hashes_file.empty() && !computed_hash.empty()) {
        if (check_replay_seen(opts.seen_hashes_file, computed_hash)) {
            res.reasons.push_back("replayed_receipt");
        }
    }

    res.valid = res.reasons.empty();
    if (res.valid && !opts.seen_hashes_file.empty()) {
        record_replay_seen(opts.seen_hashes_file, computed_hash);
    }

    return res;
}

} // namespace jc::witness
