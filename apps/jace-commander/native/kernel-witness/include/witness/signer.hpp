#pragma once

#include "witness/canonical_json.hpp"
#include "witness/receipt.hpp"

#include <atomic>
#include <cstdint>
#include <optional>
#include <string>
#include <sys/types.h>
#include <vector>

namespace jc::witness {

struct KeyRecord {
    std::string key_id;
    std::string public_key_pem;
    std::string private_key_path;
    std::string state{"active"}; // "active" | "rotated" | "retired" | "revoked"
    std::string created_at_utc;
    std::optional<std::string> rotated_at_utc;
    std::optional<std::string> retired_at_utc;
    std::optional<std::string> revoked_at_utc;
    std::optional<std::string> revocation_reason;
    std::optional<std::string> replaced_by_key_id;
};

struct KeyManifest {
    std::string schema_version{"jc.kernel-witness.key-manifest.v1"};
    std::string active_key_id;
    std::vector<KeyRecord> keys;
};

KeyManifest load_key_manifest(const std::string& path);
void save_key_manifest(const std::string& path, const KeyManifest& manifest);

KeyRecord key_admin_register(
    const std::string& manifest_path,
    const std::string& private_key_out,
    const std::string& public_key_out);

KeyRecord key_admin_rotate(
    const std::string& manifest_path,
    const std::string& new_private_key_out,
    const std::string& new_public_key_out);

void key_admin_retire(
    const std::string& manifest_path,
    const std::string& key_id,
    const std::string& retired_at_utc = "");

void key_admin_revoke(
    const std::string& manifest_path,
    const std::string& key_id,
    const std::string& reason);

struct SignerConfig {
    std::string socket_path;
    std::string private_key_path;
    std::string key_manifest_path;
    std::string audit_log_path;
    std::vector<uid_t> allowed_uids;
    std::optional<uid_t> forbidden_workload_uid;
    std::vector<std::string> allowed_exe_paths;
    bool require_distinct_uid{false};
    bool allow_synthetic_for_tests{false};
    int64_t max_clock_skew_ms{60000};
};

struct SignerAuditEntry {
    uint64_t seq{0};
    std::string timestamp_utc;
    pid_t peer_pid{0};
    uid_t peer_uid{0};
    gid_t peer_gid{0};
    std::string work_item_id;
    std::string attempt_id;
    std::string lease_id;
    std::string invocation_hash;
    std::string signing_key_id;
    std::string evidence_hash;
    bool approved{false};
    std::string reason;
    std::string prev_audit_hash;
    std::string audit_hash;
};

bool verify_signer_audit_log(const std::string& audit_log_path, std::string& error_out, size_t* count_out = nullptr);

class SignerDaemon {
public:
    explicit SignerDaemon(SignerConfig cfg);
    ~SignerDaemon();

    SignerDaemon(const SignerDaemon&) = delete;
    SignerDaemon& operator=(const SignerDaemon&) = delete;

    void start_listening();
    bool handle_one_request(int timeout_ms = -1);
    void serve_forever(std::atomic<bool>& stop_flag);
    void stop();

private:
    SignerConfig cfg_;
    int listen_fd_{-1};
    std::string private_key_pem_;
    std::string signing_key_id_;
    uint64_t audit_seq_{0};
    std::string last_audit_hash_{"0000000000000000000000000000000000000000000000000000000000000000"};
    std::map<std::string, std::string> lease_last_hash_;

    void load_and_verify_key();
    void init_audit_state();
    void record_audit(
        pid_t peer_pid,
        uid_t peer_uid,
        gid_t peer_gid,
        const std::string& work_item_id,
        const std::string& attempt_id,
        const std::string& lease_id,
        const std::string& invocation_hash,
        const std::string& evidence_hash,
        bool approved,
        const std::string& reason);
    JsonValue process_sign_request(
        const JsonValue& req,
        pid_t peer_pid,
        uid_t peer_uid,
        gid_t peer_gid);
};

void sign_receipt_via_socket(ObservationReceipt& r, const std::string& socket_path);

int run_signerd_cli(int argc, char** argv, int start_idx = 1);
int run_key_admin_cli(int argc, char** argv, int start_idx = 1);

} // namespace jc::witness
