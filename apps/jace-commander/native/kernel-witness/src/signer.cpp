#include "witness/signer.hpp"
#include "witness/crypto.hpp"

#include <algorithm>
#include <cerrno>
#include <csignal>
#include <cstring>
#include <filesystem>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <poll.h>
#include <sstream>
#include <stdexcept>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace jc::witness {

namespace {

std::string read_file_str(const std::string& path) {
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) throw std::runtime_error("failed to open file: " + path);
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

void write_file_atomic(const std::string& path, const std::string& content, mode_t mode = 0644) {
    std::string tmp_path = path + ".tmp." + std::to_string(getpid());
    int fd = open(tmp_path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode);
    if (fd < 0) {
        throw std::runtime_error("failed to create temp file: " + tmp_path);
    }
    fchmod(fd, mode);
    size_t written = 0;
    while (written < content.size()) {
        ssize_t n = write(fd, content.data() + written, content.size() - written);
        if (n <= 0) {
            close(fd);
            unlink(tmp_path.c_str());
            throw std::runtime_error("failed to write temp file: " + tmp_path);
        }
        written += static_cast<size_t>(n);
    }
    fsync(fd);
    close(fd);
    if (rename(tmp_path.c_str(), path.c_str()) != 0) {
        unlink(tmp_path.c_str());
        throw std::runtime_error("failed to rename temp file to: " + path);
    }
}

std::string get_opt_str(const JsonObject& obj, const std::string& key) {
    auto it = obj.find(key);
    if (it == obj.end() || it->second.is_null() || !it->second.is_string()) return "";
    return it->second.as_string();
}

JsonValue key_record_to_json(const KeyRecord& kr) {
    JsonObject obj;
    obj["keyId"] = kr.key_id;
    obj["publicKeyPem"] = kr.public_key_pem;
    obj["privateKeyPath"] = kr.private_key_path;
    obj["state"] = kr.state;
    obj["createdAtUtc"] = kr.created_at_utc;
    obj["rotatedAtUtc"] = kr.rotated_at_utc.has_value() ? JsonValue(*kr.rotated_at_utc) : JsonValue(nullptr);
    obj["retiredAtUtc"] = kr.retired_at_utc.has_value() ? JsonValue(*kr.retired_at_utc) : JsonValue(nullptr);
    obj["revokedAtUtc"] = kr.revoked_at_utc.has_value() ? JsonValue(*kr.revoked_at_utc) : JsonValue(nullptr);
    obj["revocationReason"] = kr.revocation_reason.has_value() ? JsonValue(*kr.revocation_reason) : JsonValue(nullptr);
    obj["replacedByKeyId"] = kr.replaced_by_key_id.has_value() ? JsonValue(*kr.replaced_by_key_id) : JsonValue(nullptr);
    return JsonValue(std::move(obj));
}

KeyRecord key_record_from_json(const JsonValue& v) {
    const auto& obj = v.as_object();
    KeyRecord kr;
    kr.key_id = get_opt_str(obj, "keyId");
    kr.public_key_pem = get_opt_str(obj, "publicKeyPem");
    kr.private_key_path = get_opt_str(obj, "privateKeyPath");
    kr.state = get_opt_str(obj, "state");
    if (kr.state.empty()) kr.state = get_opt_str(obj, "status");
    if (kr.state.empty()) kr.state = "active";
    kr.created_at_utc = get_opt_str(obj, "createdAtUtc");
    std::string rot = get_opt_str(obj, "rotatedAtUtc");
    if (!rot.empty()) kr.rotated_at_utc = rot;
    std::string ret = get_opt_str(obj, "retiredAtUtc");
    if (!ret.empty()) kr.retired_at_utc = ret;
    std::string rev = get_opt_str(obj, "revokedAtUtc");
    if (!rev.empty()) kr.revoked_at_utc = rev;
    std::string rreason = get_opt_str(obj, "revocationReason");
    if (!rreason.empty()) kr.revocation_reason = rreason;
    std::string repl = get_opt_str(obj, "replacedByKeyId");
    if (!repl.empty()) kr.replaced_by_key_id = repl;
    return kr;
}

std::string read_line_from_fd(int fd, size_t max_len = 8 * 1024 * 1024) {
    std::string out;
    char buf[4096];
    while (out.size() < max_len) {
        ssize_t n = read(fd, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR) continue;
            throw std::runtime_error(std::string("socket read failed: ") + std::strerror(errno));
        }
        if (n == 0) break;
        out.append(buf, static_cast<size_t>(n));
        if (out.find('\n') != std::string::npos) break;
    }
    return out;
}

void write_all_to_fd(int fd, std::string_view data) {
    size_t written = 0;
    while (written < data.size()) {
        ssize_t n = write(fd, data.data() + written, data.size() - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            throw std::runtime_error(std::string("socket write failed: ") + std::strerror(errno));
        }
        written += static_cast<size_t>(n);
    }
}

JsonObject audit_entry_body(const SignerAuditEntry& e) {
    JsonObject obj;
    obj["seq"] = e.seq;
    obj["timestampUtc"] = e.timestamp_utc;
    obj["peerPid"] = static_cast<int64_t>(e.peer_pid);
    obj["peerUid"] = static_cast<uint64_t>(e.peer_uid);
    obj["peerGid"] = static_cast<uint64_t>(e.peer_gid);
    obj["workItemId"] = e.work_item_id;
    obj["attemptId"] = e.attempt_id;
    obj["leaseId"] = e.lease_id;
    obj["invocationHash"] = e.invocation_hash;
    obj["signingKeyId"] = e.signing_key_id;
    obj["evidenceHash"] = e.evidence_hash;
    obj["approved"] = e.approved;
    obj["reason"] = e.reason;
    obj["prevAuditHash"] = e.prev_audit_hash;
    return obj;
}

} // namespace

KeyManifest load_key_manifest(const std::string& path) {
    KeyManifest m;
    if (!std::filesystem::exists(path)) {
        return m;
    }
    JsonValue v = parse_json(read_file_str(path));
    const auto& obj = v.as_object();
    m.schema_version = get_opt_str(obj, "schemaVersion");
    if (m.schema_version.empty()) m.schema_version = "jc.kernel-witness.key-manifest.v1";
    m.active_key_id = get_opt_str(obj, "activeKeyId");
    auto it = obj.find("keys");
    if (it != obj.end() && it->second.is_array()) {
        for (const auto& kv : it->second.as_array()) {
            m.keys.push_back(key_record_from_json(kv));
        }
    }
    return m;
}

void save_key_manifest(const std::string& path, const KeyManifest& manifest) {
    JsonObject obj;
    obj["schemaVersion"] = manifest.schema_version;
    obj["activeKeyId"] = manifest.active_key_id;
    JsonArray arr;
    arr.reserve(manifest.keys.size());
    for (const auto& k : manifest.keys) {
        arr.push_back(key_record_to_json(k));
    }
    obj["keys"] = JsonValue(std::move(arr));
    write_file_atomic(path, serialize_canonical_json(JsonValue(std::move(obj))) + "\n", 0644);
}

KeyRecord key_admin_register(
    const std::string& manifest_path,
    const std::string& private_key_out,
    const std::string& public_key_out)
{
    generate_ed25519_keypair_pem(private_key_out, public_key_out);
    std::string pub_pem = read_file_str(public_key_out);
    std::string key_id = derive_key_id_from_public_pem(pub_pem, false);

    KeyManifest m = load_key_manifest(manifest_path);
    KeyRecord kr;
    kr.key_id = key_id;
    kr.public_key_pem = pub_pem;
    kr.private_key_path = private_key_out;
    kr.state = "active";
    kr.created_at_utc = current_utc_iso8601();

    m.active_key_id = key_id;
    m.keys.push_back(kr);
    save_key_manifest(manifest_path, m);
    return kr;
}

KeyRecord key_admin_rotate(
    const std::string& manifest_path,
    const std::string& new_private_key_out,
    const std::string& new_public_key_out)
{
    generate_ed25519_keypair_pem(new_private_key_out, new_public_key_out);
    std::string pub_pem = read_file_str(new_public_key_out);
    std::string new_key_id = derive_key_id_from_public_pem(pub_pem, false);
    std::string now_utc = current_utc_iso8601();

    KeyManifest m = load_key_manifest(manifest_path);
    for (auto& existing : m.keys) {
        if (existing.state == "active") {
            existing.state = "rotated";
            existing.rotated_at_utc = now_utc;
            existing.replaced_by_key_id = new_key_id;
        }
    }

    KeyRecord kr;
    kr.key_id = new_key_id;
    kr.public_key_pem = pub_pem;
    kr.private_key_path = new_private_key_out;
    kr.state = "active";
    kr.created_at_utc = now_utc;

    m.active_key_id = new_key_id;
    m.keys.push_back(kr);
    save_key_manifest(manifest_path, m);
    return kr;
}

void key_admin_retire(
    const std::string& manifest_path,
    const std::string& key_id,
    const std::string& retired_at_utc)
{
    KeyManifest m = load_key_manifest(manifest_path);
    bool found = false;
    std::string ts = retired_at_utc.empty() ? current_utc_iso8601() : retired_at_utc;
    for (auto& k : m.keys) {
        if (k.key_id == key_id) {
            if (k.state == "revoked") {
                throw std::runtime_error("cannot retire an already revoked key: " + key_id);
            }
            k.state = "retired";
            k.retired_at_utc = ts;
            found = true;
        }
    }
    if (!found) {
        throw std::runtime_error("key_id not found in manifest: " + key_id);
    }
    if (m.active_key_id == key_id) {
        m.active_key_id.clear();
    }
    save_key_manifest(manifest_path, m);
}

void key_admin_revoke(
    const std::string& manifest_path,
    const std::string& key_id,
    const std::string& reason)
{
    KeyManifest m = load_key_manifest(manifest_path);
    bool found = false;
    std::string ts = current_utc_iso8601();
    for (auto& k : m.keys) {
        if (k.key_id == key_id) {
            k.state = "revoked";
            k.revoked_at_utc = ts;
            k.revocation_reason = reason.empty() ? "administrative_revocation" : reason;
            found = true;
        }
    }
    if (!found) {
        throw std::runtime_error("key_id not found in manifest: " + key_id);
    }
    if (m.active_key_id == key_id) {
        m.active_key_id.clear();
    }
    save_key_manifest(manifest_path, m);
}

bool verify_signer_audit_log(const std::string& audit_log_path, std::string& error_out, size_t* count_out) {
    if (count_out) *count_out = 0;
    std::ifstream ifs(audit_log_path, std::ios::binary);
    if (!ifs) {
        error_out = "failed_to_open_audit_log";
        return false;
    }
    std::string prev_hash = "0000000000000000000000000000000000000000000000000000000000000000";
    uint64_t expected_seq = 1;
    std::string line;
    size_t count = 0;
    while (std::getline(ifs, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) {
            line.pop_back();
        }
        if (line.empty()) continue;
        JsonValue v = parse_json(line);
        if (!v.is_object()) {
            error_out = "audit_entry_not_object";
            return false;
        }
        JsonObject obj = v.as_object();
        uint64_t seq = obj.at("seq").as_uint64();
        if (seq != expected_seq) {
            error_out = "audit_seq_gap_at_" + std::to_string(expected_seq);
            return false;
        }
        std::string claimed_prev = get_opt_str(obj, "prevAuditHash");
        if (claimed_prev != prev_hash) {
            error_out = "audit_prev_hash_mismatch_at_seq_" + std::to_string(seq);
            return false;
        }
        std::string claimed_hash = get_opt_str(obj, "auditHash");
        obj.erase("auditHash");
        std::string canonical = serialize_canonical_json(JsonValue(std::move(obj)));
        std::string computed_hash = sha256_hex("jc.kernel-witness.signer-audit.v2:" + canonical);
        if (computed_hash != claimed_hash) {
            error_out = "audit_hash_tampered_at_seq_" + std::to_string(seq);
            return false;
        }
        prev_hash = computed_hash;
        ++expected_seq;
        ++count;
    }
    if (count_out) *count_out = count;
    return true;
}

SignerDaemon::SignerDaemon(SignerConfig cfg) : cfg_(std::move(cfg)) {
    load_and_verify_key();
    init_audit_state();
}

SignerDaemon::~SignerDaemon() {
    stop();
}

void SignerDaemon::load_and_verify_key() {
    if (cfg_.private_key_path.empty()) {
        throw std::runtime_error("SignerDaemon requires private_key_path");
    }
    struct stat st{};
    if (stat(cfg_.private_key_path.c_str(), &st) != 0) {
        throw std::runtime_error("failed to stat private key: " + cfg_.private_key_path);
    }
    if ((st.st_mode & 0077) != 0) {
        throw std::runtime_error("private_key_permissions_too_open: " + cfg_.private_key_path + " must be 0600");
    }
    private_key_pem_ = read_file_str(cfg_.private_key_path);
    signing_key_id_ = derive_key_id_from_private_pem(private_key_pem_, false);
}

void SignerDaemon::init_audit_state() {
    if (cfg_.audit_log_path.empty() || !std::filesystem::exists(cfg_.audit_log_path)) {
        return;
    }
    std::ifstream ifs(cfg_.audit_log_path, std::ios::binary);
    std::string line;
    while (std::getline(ifs, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) {
            line.pop_back();
        }
        if (line.empty()) continue;
        JsonValue v = parse_json(line);
        if (v.is_object()) {
            const auto& obj = v.as_object();
            auto seq_it = obj.find("seq");
            if (seq_it != obj.end() && seq_it->second.is_number()) {
                audit_seq_ = seq_it->second.as_uint64();
            }
            std::string ah = get_opt_str(obj, "auditHash");
            if (!ah.empty()) last_audit_hash_ = ah;
        }
    }
}

void SignerDaemon::record_audit(
    pid_t peer_pid,
    uid_t peer_uid,
    gid_t peer_gid,
    const std::string& work_item_id,
    const std::string& attempt_id,
    const std::string& lease_id,
    const std::string& invocation_hash,
    const std::string& evidence_hash,
    bool approved,
    const std::string& reason)
{
    if (cfg_.audit_log_path.empty()) return;

    SignerAuditEntry entry;
    entry.seq = ++audit_seq_;
    entry.timestamp_utc = current_utc_iso8601();
    entry.peer_pid = peer_pid;
    entry.peer_uid = peer_uid;
    entry.peer_gid = peer_gid;
    entry.work_item_id = work_item_id;
    entry.attempt_id = attempt_id;
    entry.lease_id = lease_id;
    entry.invocation_hash = invocation_hash;
    entry.signing_key_id = signing_key_id_;
    entry.evidence_hash = evidence_hash;
    entry.approved = approved;
    entry.reason = reason;
    entry.prev_audit_hash = last_audit_hash_;

    JsonObject body = audit_entry_body(entry);
    std::string canonical_body = serialize_canonical_json(JsonValue(body));
    entry.audit_hash = sha256_hex("jc.kernel-witness.signer-audit.v2:" + canonical_body);
    last_audit_hash_ = entry.audit_hash;
    body["auditHash"] = entry.audit_hash;

    std::string line = serialize_canonical_json(JsonValue(std::move(body))) + "\n";
    int fd = open(cfg_.audit_log_path.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd >= 0) {
        flock(fd, LOCK_EX);
        write_all_to_fd(fd, line);
        fsync(fd);
        flock(fd, LOCK_UN);
        close(fd);
    }
}

void SignerDaemon::start_listening() {
    if (listen_fd_ >= 0) return;
    if (cfg_.socket_path.empty()) {
        throw std::runtime_error("SignerDaemon socket_path is empty");
    }
    if (cfg_.socket_path.size() >= sizeof(sockaddr_un::sun_path)) {
        throw std::runtime_error("SignerDaemon socket_path exceeds sun_path limit");
    }

    unlink(cfg_.socket_path.c_str());

    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        throw std::runtime_error(std::string("socket(AF_UNIX) failed: ") + std::strerror(errno));
    }

    struct sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, cfg_.socket_path.c_str(), sizeof(addr.sun_path) - 1);

    if (bind(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) != 0) {
        int err = errno;
        close(fd);
        throw std::runtime_error(std::string("bind(AF_UNIX) failed: ") + std::strerror(err));
    }

    chmod(cfg_.socket_path.c_str(), 0666);

    if (listen(fd, 16) != 0) {
        int err = errno;
        close(fd);
        unlink(cfg_.socket_path.c_str());
        throw std::runtime_error(std::string("listen(AF_UNIX) failed: ") + std::strerror(err));
    }

    listen_fd_ = fd;
}

void SignerDaemon::stop() {
    if (listen_fd_ >= 0) {
        close(listen_fd_);
        listen_fd_ = -1;
    }
    if (!cfg_.socket_path.empty()) {
        unlink(cfg_.socket_path.c_str());
    }
}

JsonValue SignerDaemon::process_sign_request(
    const JsonValue& req,
    pid_t peer_pid,
    uid_t peer_uid,
    gid_t peer_gid)
{
    auto reject = [&](const std::string& reason,
                      const std::string& wi = "",
                      const std::string& att = "",
                      const std::string& lease = "",
                      const std::string& inv = "") -> JsonValue {
        record_audit(peer_pid, peer_uid, peer_gid, wi, att, lease, inv, "", false, reason);
        JsonObject out;
        out["ok"] = false;
        out["error"] = reason;
        return JsonValue(std::move(out));
    };

    if (cfg_.require_distinct_uid && peer_uid == geteuid()) {
        return reject("peer_uid_matches_signer_uid_rejected");
    }
    if (cfg_.forbidden_workload_uid.has_value() && peer_uid == *cfg_.forbidden_workload_uid) {
        return reject("peer_uid_is_sandboxed_workload_rejected");
    }
    if (!cfg_.allowed_uids.empty()) {
        if (std::find(cfg_.allowed_uids.begin(), cfg_.allowed_uids.end(), peer_uid) == cfg_.allowed_uids.end()) {
            return reject("peer_uid_unauthorized:" + std::to_string(peer_uid));
        }
    }
    if (!cfg_.allowed_exe_paths.empty()) {
        char exe_buf[4096]{};
        std::string proc_exe = "/proc/" + std::to_string(peer_pid) + "/exe";
        ssize_t len = readlink(proc_exe.c_str(), exe_buf, sizeof(exe_buf) - 1);
        std::string actual_exe = (len > 0) ? std::string(exe_buf, static_cast<size_t>(len)) : "";
        if (std::find(cfg_.allowed_exe_paths.begin(), cfg_.allowed_exe_paths.end(), actual_exe) ==
            cfg_.allowed_exe_paths.end()) {
            return reject("peer_exe_unauthorized:" + actual_exe);
        }
    }

    if (!req.is_object()) {
        return reject("request_not_json_object");
    }
    const auto& req_obj = req.as_object();
    auto body_it = req_obj.find("receiptBody");
    if (body_it == req_obj.end() || !body_it->second.is_object()) {
        return reject("missing_receipt_body");
    }

    JsonObject body = body_it->second.as_object();
    std::string wi = get_opt_str(body, "workItemId");
    std::string att = get_opt_str(body, "attemptId");
    std::string lease = get_opt_str(body, "leaseId");
    std::string inv = get_opt_str(body, "invocationHash");

    // Check key manifest state before signing
    if (!cfg_.key_manifest_path.empty() && std::filesystem::exists(cfg_.key_manifest_path)) {
        KeyManifest m = load_key_manifest(cfg_.key_manifest_path);
        const KeyRecord* kr = nullptr;
        for (const auto& k : m.keys) {
            if (k.key_id == signing_key_id_) {
                kr = &k;
                break;
            }
        }
        if (!kr) {
            return reject("signing_key_unregistered_in_manifest", wi, att, lease, inv);
        }
        if (kr->state == "revoked") {
            return reject("signing_key_revoked", wi, att, lease, inv);
        }
        if (kr->state == "retired") {
            return reject("signing_key_retired", wi, att, lease, inv);
        }
        if (kr->state != "active" && kr->state != "rotated") {
            return reject("signing_key_not_active:" + kr->state, wi, att, lease, inv);
        }
    }

    std::string schema_ver = get_opt_str(body, "schemaVersion");
    bool is_v1 = (schema_ver == kReceiptSchemaVersionV1);
    bool is_v2 = (schema_ver == kReceiptSchemaVersionV2);
    if (!is_v1 && !is_v2) {
        return reject("invalid_schema_version", wi, att, lease, inv);
    }

    std::string obs_mode = get_opt_str(body, "observerMode");
    if (obs_mode != "live" && !cfg_.allow_synthetic_for_tests) {
        return reject("observer_mode_not_live_rejected:" + obs_mode, wi, att, lease, inv);
    }

    if (wi.empty() || att.empty() || lease.empty() || inv.empty()) {
        return reject("missing_correlation_fields", wi, att, lease, inv);
    }

    auto cg_it = body.find("cgroupId");
    auto rp_it = body.find("rootPid");
    if (cg_it == body.end() || !cg_it->second.is_number() || cg_it->second.as_uint64() == 0 ||
        rp_it == body.end() || !rp_it->second.is_number() || rp_it->second.as_uint64() == 0) {
        return reject("invalid_cgroup_or_root_pid", wi, att, lease, inv);
    }

    auto st_it = body.find("startTimeNs");
    auto et_it = body.find("endTimeNs");
    if (st_it == body.end() || !st_it->second.is_number() ||
        et_it == body.end() || !et_it->second.is_number() ||
        st_it->second.as_uint64() > et_it->second.as_uint64()) {
        return reject("invalid_timestamp_range", wi, att, lease, inv);
    }

    std::string prev_hash = get_opt_str(body, "previousEvidenceHash");
    auto lease_it = lease_last_hash_.find(lease);
    if (lease_it != lease_last_hash_.end()) {
        if (prev_hash != lease_it->second) {
            return reject("broken_lease_hash_chain", wi, att, lease, inv);
        }
    }

    std::string now_utc = current_utc_iso8601();
    std::string req_signed_at = get_opt_str(body, "signedAtUtc");
    if (!req_signed_at.empty()) {
        auto req_ms = parse_utc_iso8601_epoch_ms(req_signed_at);
        auto now_ms = parse_utc_iso8601_epoch_ms(now_utc);
        if (!req_ms.has_value() || !now_ms.has_value() ||
            std::llabs(*now_ms - *req_ms) > cfg_.max_clock_skew_ms) {
            return reject("receipt_timestamp_stale_or_skewed", wi, att, lease, inv);
        }
    } else if (is_v2) {
        body["signedAtUtc"] = now_utc;
        req_signed_at = now_utc;
    }

    if (is_v2) {
        auto tree_it = body.find("processTree");
        auto fs_it = body.find("filesystemEvents");
        auto net_it = body.find("networkEvents");
        auto cc_it = body.find("categoryCompleteness");
        if (tree_it == body.end() || !tree_it->second.is_array() ||
            fs_it == body.end() || !fs_it->second.is_array() ||
            net_it == body.end() || !net_it->second.is_array() ||
            cc_it == body.end() || !cc_it->second.is_object()) {
            return reject("missing_v2_category_arrays_or_completeness", wi, att, lease, inv);
        }
        const auto& cc_obj = cc_it->second.as_object();
        std::string exp_proc = sha256_hex("jc.kernel-witness.category.process.v2:" + serialize_canonical_json(tree_it->second));
        std::string exp_fs = sha256_hex("jc.kernel-witness.category.filesystem.v2:" + serialize_canonical_json(fs_it->second));
        std::string exp_net = sha256_hex("jc.kernel-witness.category.network.v2:" + serialize_canonical_json(net_it->second));

        auto check_dig = [&](const char* cname, const std::string& exp) -> bool {
            auto cit = cc_obj.find(cname);
            if (cit == cc_obj.end() || !cit->second.is_object()) return false;
            return get_opt_str(cit->second.as_object(), "categoryDigestSha256") == exp;
        };
        if (!check_dig("process", exp_proc) || !check_dig("filesystem", exp_fs) || !check_dig("network", exp_net)) {
            return reject("category_digest_mismatch", wi, att, lease, inv);
        }
    }

    body["signingKeyId"] = signing_key_id_;
    body.erase("evidenceHash");
    body.erase("signature");

    std::string canonical_body = serialize_canonical_json(JsonValue(std::move(body)));
    std::string evidence_hash = is_v1
        ? sha256_hex(canonical_body)
        : sha256_hex("jc.kernel-witness.receipt.v2:" + canonical_body);
    std::string sign_payload = is_v1
        ? canonical_body
        : ("jc.kernel-witness.sig.v2:" + evidence_hash + ":" + canonical_body);
    std::string signature = ed25519_sign_pem(sign_payload, private_key_pem_, false);

    lease_last_hash_[lease] = evidence_hash;
    record_audit(peer_pid, peer_uid, peer_gid, wi, att, lease, inv, evidence_hash, true, "signed");

    JsonObject out;
    out["ok"] = true;
    out["signingKeyId"] = signing_key_id_;
    out["signedAtUtc"] = req_signed_at;
    out["evidenceHash"] = evidence_hash;
    out["signature"] = signature;
    return JsonValue(std::move(out));
}

bool SignerDaemon::handle_one_request(int timeout_ms) {
    if (listen_fd_ < 0) start_listening();

    struct pollfd pfd{};
    pfd.fd = listen_fd_;
    pfd.events = POLLIN;
    int prc = poll(&pfd, 1, timeout_ms);
    if (prc <= 0) return false;

    int client_fd = accept4(listen_fd_, nullptr, nullptr, SOCK_CLOEXEC);
    if (client_fd < 0) return false;

    struct ucred cred{};
    socklen_t cred_len = sizeof(cred);
    if (getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len) != 0) {
        close(client_fd);
        return false;
    }

    try {
        std::string req_line = read_line_from_fd(client_fd);
        JsonValue req = parse_json(req_line);
        JsonValue resp = process_sign_request(req, cred.pid, cred.uid, cred.gid);
        std::string resp_str = serialize_canonical_json(resp) + "\n";
        write_all_to_fd(client_fd, resp_str);
    } catch (const std::exception& ex) {
        record_audit(cred.pid, cred.uid, cred.gid, "", "", "", "", "", false, std::string("parse_error:") + ex.what());
        JsonObject err_obj;
        err_obj["ok"] = false;
        err_obj["error"] = std::string("bad_request:") + ex.what();
        try {
            write_all_to_fd(client_fd, serialize_canonical_json(JsonValue(std::move(err_obj))) + "\n");
        } catch (...) {}
    }

    close(client_fd);
    return true;
}

void SignerDaemon::serve_forever(std::atomic<bool>& stop_flag) {
    start_listening();
    while (!stop_flag.load()) {
        handle_one_request(100);
    }
}

void sign_receipt_via_socket(ObservationReceipt& r, const std::string& socket_path) {
    if (socket_path.size() >= sizeof(sockaddr_un::sun_path)) {
        throw std::runtime_error("signer socket path exceeds sun_path limit");
    }

    if (r.schema_version != kReceiptSchemaVersionV1) {
        if (r.signed_at_utc.empty()) {
            r.signed_at_utc = current_utc_iso8601();
        }
        populate_receipt_completeness_digests(r);
    }

    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        throw std::runtime_error(std::string("socket(AF_UNIX) failed: ") + std::strerror(errno));
    }

    struct sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, socket_path.c_str(), sizeof(addr.sun_path) - 1);

    if (connect(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) != 0) {
        int err = errno;
        close(fd);
        throw std::runtime_error("failed to connect to jc-witness-signerd at " + socket_path + ": " + std::strerror(err));
    }

    JsonObject req_obj;
    req_obj["receiptBody"] = receipt_body_to_json(r);
    std::string payload = serialize_canonical_json(JsonValue(std::move(req_obj))) + "\n";
    write_all_to_fd(fd, payload);

    std::string resp_line = read_line_from_fd(fd);
    close(fd);

    JsonValue resp = parse_json(resp_line);
    const auto& robj = resp.as_object();
    auto ok_it = robj.find("ok");
    if (ok_it == robj.end() || !ok_it->second.is_bool() || !ok_it->second.as_bool()) {
        std::string err = get_opt_str(robj, "error");
        throw std::runtime_error("jc-witness-signerd rejected signing request: " + err);
    }

    r.signing_key_id = get_opt_str(robj, "signingKeyId");
    std::string server_signed_at = get_opt_str(robj, "signedAtUtc");
    if (!server_signed_at.empty()) {
        r.signed_at_utc = server_signed_at;
    }
    r.evidence_hash = get_opt_str(robj, "evidenceHash");
    r.signature = get_opt_str(robj, "signature");
}

namespace {
std::atomic<bool> g_signerd_stop{false};
void handle_signerd_sig(int /*sig*/) {
    g_signerd_stop.store(true);
}
} // namespace

int run_signerd_cli(int argc, char** argv, int start_idx) {
    SignerConfig cfg;
    bool one_shot = false;
    for (int i = start_idx; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--socket" && i + 1 < argc) cfg.socket_path = argv[++i];
        else if (arg == "--private-key" && i + 1 < argc) cfg.private_key_path = argv[++i];
        else if (arg == "--key-manifest" && i + 1 < argc) cfg.key_manifest_path = argv[++i];
        else if (arg == "--audit-log" && i + 1 < argc) cfg.audit_log_path = argv[++i];
        else if (arg == "--allow-uid" && i + 1 < argc) cfg.allowed_uids.push_back(static_cast<uid_t>(std::stoul(argv[++i])));
        else if (arg == "--forbid-workload-uid" && i + 1 < argc) cfg.forbidden_workload_uid = static_cast<uid_t>(std::stoul(argv[++i]));
        else if (arg == "--allow-exe" && i + 1 < argc) cfg.allowed_exe_paths.emplace_back(argv[++i]);
        else if (arg == "--require-distinct-uid") cfg.require_distinct_uid = true;
        else if (arg == "--allow-same-uid-for-tests") cfg.require_distinct_uid = false;
        else if (arg == "--allow-synthetic-for-tests") cfg.allow_synthetic_for_tests = true;
        else if (arg == "--max-clock-skew-ms" && i + 1 < argc) cfg.max_clock_skew_ms = std::stoll(argv[++i]);
        else if (arg == "--once") one_shot = true;
        else {
            std::cerr << "Unknown signerd option: " << arg << "\n";
            return 2;
        }
    }

    if (cfg.socket_path.empty() || cfg.private_key_path.empty()) {
        std::cerr << "signerd requires --socket <path> and --private-key <path>\n";
        return 2;
    }

    std::signal(SIGINT, handle_signerd_sig);
    std::signal(SIGTERM, handle_signerd_sig);

    SignerDaemon daemon(cfg);
    daemon.start_listening();
    if (one_shot) {
        daemon.handle_one_request(30000);
    } else {
        daemon.serve_forever(g_signerd_stop);
    }
    return 0;
}

int run_key_admin_cli(int argc, char** argv, int start_idx) {
    if (start_idx >= argc) {
        std::cerr << "key-admin requires action: register | rotate | retire | revoke\n";
        return 2;
    }
    std::string action = argv[start_idx];
    std::string manifest_path, priv_out, pub_out, key_id, reason, retired_at;
    for (int i = start_idx + 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--manifest" && i + 1 < argc) manifest_path = argv[++i];
        else if (arg == "--private-out" && i + 1 < argc) priv_out = argv[++i];
        else if (arg == "--public-out" && i + 1 < argc) pub_out = argv[++i];
        else if (arg == "--key-id" && i + 1 < argc) key_id = argv[++i];
        else if (arg == "--reason" && i + 1 < argc) reason = argv[++i];
        else if (arg == "--retired-at" && i + 1 < argc) retired_at = argv[++i];
        else {
            std::cerr << "Unknown key-admin option: " << arg << "\n";
            return 2;
        }
    }

    if (manifest_path.empty()) {
        std::cerr << "key-admin requires --manifest <path>\n";
        return 2;
    }

    if (action == "register") {
        if (priv_out.empty() || pub_out.empty()) {
            std::cerr << "key-admin register requires --private-out and --public-out\n";
            return 2;
        }
        KeyRecord kr = key_admin_register(manifest_path, priv_out, pub_out);
        JsonObject out;
        out["action"] = "register";
        out["keyId"] = kr.key_id;
        out["state"] = kr.state;
        std::cout << serialize_canonical_json(JsonValue(std::move(out))) << "\n";
        return 0;
    }
    if (action == "rotate") {
        if (priv_out.empty() || pub_out.empty()) {
            std::cerr << "key-admin rotate requires --private-out and --public-out\n";
            return 2;
        }
        KeyRecord kr = key_admin_rotate(manifest_path, priv_out, pub_out);
        JsonObject out;
        out["action"] = "rotate";
        out["keyId"] = kr.key_id;
        out["state"] = kr.state;
        std::cout << serialize_canonical_json(JsonValue(std::move(out))) << "\n";
        return 0;
    }
    if (action == "retire") {
        if (key_id.empty()) {
            std::cerr << "key-admin retire requires --key-id\n";
            return 2;
        }
        key_admin_retire(manifest_path, key_id, retired_at);
        JsonObject out;
        out["action"] = "retire";
        out["keyId"] = key_id;
        out["state"] = "retired";
        std::cout << serialize_canonical_json(JsonValue(std::move(out))) << "\n";
        return 0;
    }
    if (action == "revoke") {
        if (key_id.empty()) {
            std::cerr << "key-admin revoke requires --key-id\n";
            return 2;
        }
        key_admin_revoke(manifest_path, key_id, reason);
        JsonObject out;
        out["action"] = "revoke";
        out["keyId"] = key_id;
        out["state"] = "revoked";
        std::cout << serialize_canonical_json(JsonValue(std::move(out))) << "\n";
        return 0;
    }

    std::cerr << "Unknown key-admin action: " << action << "\n";
    return 2;
}

} // namespace jc::witness
