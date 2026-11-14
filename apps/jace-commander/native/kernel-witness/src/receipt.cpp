#include "witness/receipt.hpp"
#include "witness/crypto.hpp"

#include <algorithm>
#include <fcntl.h>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <sys/file.h>
#include <unistd.h>

namespace jc::witness {

void populate_receipt_completeness_digests(ObservationReceipt& r) {
    if (r.category_completeness.process.category.empty()) {
        r.category_completeness.process.category = "process";
    }
    if (r.category_completeness.filesystem.category.empty()) {
        r.category_completeness.filesystem.category = "filesystem";
    }
    if (r.category_completeness.network.category.empty()) {
        r.category_completeness.network.category = "network";
    }
    r.category_completeness.process.category_digest_sha256 = compute_process_category_digest(r.process_tree);
    r.category_completeness.filesystem.category_digest_sha256 = compute_filesystem_category_digest(r.filesystem_events);
    r.category_completeness.network.category_digest_sha256 = compute_network_category_digest(r.network_events);
}

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
    if (r.schema_version != kReceiptSchemaVersionV1) {
        counts_obj["filesystem"] = r.event_counts.filesystem;
        counts_obj["network"] = r.event_counts.network;
    }
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

    if (r.schema_version != kReceiptSchemaVersionV1) {
        obj["signedAtUtc"] = r.signed_at_utc;
        obj["observationScope"] = observation_scope_to_json(r.observation_scope);
        obj["categoryCompleteness"] = category_completeness_to_json(r.category_completeness);

        JsonArray fs_arr;
        fs_arr.reserve(r.filesystem_events.size());
        for (const auto& fev : r.filesystem_events) {
            fs_arr.push_back(filesystem_event_to_json(fev));
        }
        obj["filesystemEvents"] = JsonValue(std::move(fs_arr));

        JsonArray net_arr;
        net_arr.reserve(r.network_events.size());
        for (const auto& nev : r.network_events) {
            net_arr.push_back(network_event_to_json(nev));
        }
        obj["networkEvents"] = JsonValue(std::move(net_arr));
    }

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
    if (r.schema_version != kReceiptSchemaVersionV1) {
        if (r.signed_at_utc.empty()) {
            r.signed_at_utc = current_utc_iso8601();
        }
        populate_receipt_completeness_digests(r);
    }

    JsonValue body = receipt_body_to_json(r);
    std::string canonical_body = serialize_canonical_json(body);

    if (r.schema_version == kReceiptSchemaVersionV1) {
        r.evidence_hash = sha256_hex(canonical_body);
        r.signature = ed25519_sign_pem(canonical_body, private_pem_or_path, is_path);
    } else {
        r.evidence_hash = sha256_hex("jc.kernel-witness.receipt.v2:" + canonical_body);
        std::string sign_payload = "jc.kernel-witness.sig.v2:" + r.evidence_hash + ":" + canonical_body;
        r.signature = ed25519_sign_pem(sign_payload, private_pem_or_path, is_path);
    }
}

namespace {

bool check_and_record_replay_locked(const std::string& file_path, const std::string& hash, bool record_if_unseen) {
    int fd = open(file_path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (fd < 0) {
        throw std::runtime_error("failed to open seen_hashes_file: " + file_path);
    }
    if (flock(fd, LOCK_EX) != 0) {
        close(fd);
        throw std::runtime_error("flock(LOCK_EX) failed on seen_hashes_file: " + file_path);
    }

    std::string content;
    char buf[4096];
    ssize_t n = 0;
    while ((n = read(fd, buf, sizeof(buf))) > 0) {
        content.append(buf, static_cast<size_t>(n));
    }

    std::istringstream iss(content);
    std::string line;
    bool already_seen = false;
    while (std::getline(iss, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) {
            line.pop_back();
        }
        if (line == hash) {
            already_seen = true;
            break;
        }
    }

    if (!already_seen && record_if_unseen) {
        lseek(fd, 0, SEEK_END);
        std::string out = hash + "\n";
        size_t written = 0;
        while (written < out.size()) {
            ssize_t w = write(fd, out.data() + written, out.size() - written);
            if (w <= 0) {
                flock(fd, LOCK_UN);
                close(fd);
                throw std::runtime_error("failed to append to seen_hashes_file: " + file_path);
            }
            written += static_cast<size_t>(w);
        }
    }

    flock(fd, LOCK_UN);
    close(fd);
    return already_seen;
}

std::string get_opt_string(const JsonObject& obj, const std::string& key) {
    auto it = obj.find(key);
    if (it == obj.end() || it->second.is_null()) return "";
    if (!it->second.is_string()) return "";
    return it->second.as_string();
}

void verify_key_manifest_if_present(
    const std::string& manifest_path,
    const std::string& signing_key_id,
    const std::string& signed_at_utc,
    std::string& resolved_public_pem_out,
    std::vector<std::string>& reasons)
{
    if (manifest_path.empty()) return;
    std::ifstream ifs(manifest_path, std::ios::binary);
    if (!ifs) {
        reasons.push_back("key_manifest_open_failed");
        return;
    }
    std::ostringstream oss;
    oss << ifs.rdbuf();
    JsonValue mv = parse_json(oss.str());
    if (!mv.is_object()) {
        reasons.push_back("key_manifest_not_object");
        return;
    }
    const auto& mobj = mv.as_object();
    auto keys_it = mobj.find("keys");
    if (keys_it == mobj.end() || !keys_it->second.is_array()) {
        reasons.push_back("key_manifest_missing_keys_array");
        return;
    }

    const JsonObject* matched_key = nullptr;
    for (const auto& kv : keys_it->second.as_array()) {
        if (kv.is_object()) {
            const auto& kobj = kv.as_object();
            if (get_opt_string(kobj, "keyId") == signing_key_id) {
                matched_key = &kobj;
                break;
            }
        }
    }
    if (!matched_key) {
        reasons.push_back("signing_key_unregistered_in_manifest");
        return;
    }

    std::string state = get_opt_string(*matched_key, "state");
    if (state.empty()) state = get_opt_string(*matched_key, "status");
    if (state == "revoked") {
        reasons.push_back("signing_key_revoked");
        return;
    }
    if (state == "retired") {
        std::string retired_at = get_opt_string(*matched_key, "retiredAtUtc");
        if (!retired_at.empty() && !signed_at_utc.empty()) {
            auto signed_ms = parse_utc_iso8601_epoch_ms(signed_at_utc);
            auto retired_ms = parse_utc_iso8601_epoch_ms(retired_at);
            if (!signed_ms.has_value() || !retired_ms.has_value() || *signed_ms > *retired_ms) {
                reasons.push_back("signing_key_retired_after_cutoff");
                return;
            }
        } else {
            reasons.push_back("signing_key_retired_missing_timestamp");
            return;
        }
    } else if (state != "active" && state != "rotated") {
        reasons.push_back("signing_key_invalid_state:" + state);
        return;
    }

    std::string pub_pem = get_opt_string(*matched_key, "publicKeyPem");
    if (!pub_pem.empty()) {
        resolved_public_pem_out = pub_pem;
    }
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

    std::string schema_ver = get_opt_string(obj, "schemaVersion");
    res.schema_version = schema_ver;
    res.signing_key_id = get_opt_string(obj, "signingKeyId");

    bool is_v1 = (schema_ver == kReceiptSchemaVersionV1);
    bool is_v2 = (schema_ver == kReceiptSchemaVersionV2);
    if (!is_v1 && !is_v2) {
        res.reasons.push_back("invalid_schema_version");
    } else if (opts.require_v2 && !is_v2) {
        res.reasons.push_back("schema_version_v2_required");
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

    std::string signed_at_utc = get_opt_string(obj, "signedAtUtc");
    if (is_v2) {
        if (signed_at_utc.empty() || !parse_utc_iso8601_epoch_ms(signed_at_utc).has_value()) {
            res.reasons.push_back("missing_or_invalid_signed_at_utc");
        }

        auto scope_it = obj.find("observationScope");
        std::vector<std::string> active_cats;
        std::vector<std::string> policy_req_cats;
        if (scope_it == obj.end() || !scope_it->second.is_object()) {
            res.reasons.push_back("missing_observation_scope");
        } else {
            const auto& sobj = scope_it->second.as_object();
            auto act_it = sobj.find("active");
            if (act_it != sobj.end() && act_it->second.is_array()) {
                for (const auto& s : act_it->second.as_array()) {
                    if (s.is_string()) active_cats.push_back(s.as_string());
                }
            }
            auto preq_it = sobj.find("policyRequired");
            if (preq_it != sobj.end() && preq_it->second.is_array()) {
                for (const auto& s : preq_it->second.as_array()) {
                    if (s.is_string()) policy_req_cats.push_back(s.as_string());
                }
            }
        }

        std::vector<std::string> check_cats = opts.required_categories.empty()
            ? policy_req_cats
            : opts.required_categories;
        for (const auto& req_cat : check_cats) {
            if (std::find(active_cats.begin(), active_cats.end(), req_cat) == active_cats.end()) {
                res.reasons.push_back("missing_active_category:" + req_cat);
            }
        }

        auto tree_it = obj.find("processTree");
        auto fs_it = obj.find("filesystemEvents");
        auto net_it = obj.find("networkEvents");
        auto cc_it = obj.find("categoryCompleteness");

        if (tree_it == obj.end() || !tree_it->second.is_array()) {
            res.reasons.push_back("missing_process_tree_array");
        }
        if (fs_it == obj.end() || !fs_it->second.is_array()) {
            res.reasons.push_back("missing_filesystem_events_array");
        }
        if (net_it == obj.end() || !net_it->second.is_array()) {
            res.reasons.push_back("missing_network_events_array");
        }
        if (cc_it == obj.end() || !cc_it->second.is_object()) {
            res.reasons.push_back("missing_category_completeness");
        } else if (tree_it != obj.end() && tree_it->second.is_array() &&
                   fs_it != obj.end() && fs_it->second.is_array() &&
                   net_it != obj.end() && net_it->second.is_array()) {
            const auto& cc_obj = cc_it->second.as_object();

            std::string exp_proc_digest = sha256_hex(
                "jc.kernel-witness.category.process.v2:" + serialize_canonical_json(tree_it->second));
            std::string exp_fs_digest = sha256_hex(
                "jc.kernel-witness.category.filesystem.v2:" + serialize_canonical_json(fs_it->second));
            std::string exp_net_digest = sha256_hex(
                "jc.kernel-witness.category.network.v2:" + serialize_canonical_json(net_it->second));

            auto check_cat_digest = [&](const std::string& cat_name, const std::string& expected_digest) {
                auto cit = cc_obj.find(cat_name);
                if (cit == cc_obj.end() || !cit->second.is_object()) {
                    res.reasons.push_back("missing_category_status:" + cat_name);
                    return;
                }
                const auto& cobj = cit->second.as_object();
                std::string actual_digest = get_opt_string(cobj, "categoryDigestSha256");
                if (actual_digest != expected_digest) {
                    res.reasons.push_back("mismatched_" + cat_name + "_category_digest");
                }
                std::string cstatus = get_opt_string(cobj, "status");
                bool req_this = (std::find(check_cats.begin(), check_cats.end(), cat_name) != check_cats.end());
                if (req_this && cstatus != "complete" && !(opts.allow_partial_categories && cstatus == "partial")) {
                    res.reasons.push_back("incomplete_category_status:" + cat_name + ":" + cstatus);
                }
            };

            check_cat_digest("process", exp_proc_digest);
            check_cat_digest("filesystem", exp_fs_digest);
            check_cat_digest("network", exp_net_digest);
        }
    }

    std::string resolved_pub = public_pem_or_path;
    bool resolved_is_path = is_path;
    if (!opts.key_manifest_path.empty()) {
        std::string manifest_pub;
        verify_key_manifest_if_present(opts.key_manifest_path, res.signing_key_id, signed_at_utc, manifest_pub, res.reasons);
        if (!manifest_pub.empty()) {
            resolved_pub = manifest_pub;
            resolved_is_path = false;
        }
    }

    if (!resolved_pub.empty()) {
        try {
            std::string expected_key_id = derive_key_id_from_public_pem(resolved_pub, resolved_is_path);
            if (!res.signing_key_id.empty() && res.signing_key_id != expected_key_id) {
                res.reasons.push_back("mismatched_signing_key_id");
            }
        } catch (...) {
            // Will be caught during signature verification below
        }
    }

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

    std::string computed_hash = is_v1
        ? sha256_hex(canonical_body)
        : sha256_hex("jc.kernel-witness.receipt.v2:" + canonical_body);
    res.evidence_hash = computed_hash;

    if (!claimed_hash.empty() && computed_hash != claimed_hash) {
        res.reasons.push_back("tampered_receipt_hash_mismatch");
    }

    if (!sig_b64.empty() && !resolved_pub.empty()) {
        try {
            std::string verify_payload = is_v1
                ? canonical_body
                : ("jc.kernel-witness.sig.v2:" + computed_hash + ":" + canonical_body);
            if (!ed25519_verify_pem(verify_payload, sig_b64, resolved_pub, resolved_is_path)) {
                res.reasons.push_back("invalid_ed25519_signature");
            }
        } catch (const std::exception& ex) {
            res.reasons.push_back(std::string("signature_verification_error:") + ex.what());
        }
    }

    if (!opts.seen_hashes_file.empty() && !computed_hash.empty()) {
        bool record_now = res.reasons.empty();
        if (check_and_record_replay_locked(opts.seen_hashes_file, computed_hash, record_now)) {
            res.reasons.push_back("replayed_receipt");
        }
    }

    res.valid = res.reasons.empty();
    return res;
}

} // namespace jc::witness
