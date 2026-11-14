#include "witness/process_tree.hpp"
#include "witness/crypto.hpp"
#include "witness_event.h"

#include <algorithm>
#include <arpa/inet.h>
#include <cstring>
#include <map>
#include <set>
#include <stdexcept>
#include <sys/socket.h>

namespace jc::witness {

std::string event_type_to_string(EventType t) {
    switch (t) {
        case EventType::Fork: return "FORK";
        case EventType::Exec: return "EXEC";
        case EventType::Exit: return "EXIT";
        case EventType::Fs:   return "FS";
        case EventType::Net:  return "NET";
    }
    throw std::runtime_error("unknown EventType");
}

EventType event_type_from_string(std::string_view s) {
    if (s == "FORK") return EventType::Fork;
    if (s == "EXEC") return EventType::Exec;
    if (s == "EXIT") return EventType::Exit;
    if (s == "FS")   return EventType::Fs;
    if (s == "NET")  return EventType::Net;
    throw std::runtime_error("invalid eventType: " + std::string(s));
}

std::string fs_op_to_string(uint32_t op) {
    switch (op) {
        case WITNESS_FS_OPENAT:     return "OPENAT";
        case WITNESS_FS_CREATE:     return "CREATE";
        case WITNESS_FS_MODIFY:     return "MODIFY";
        case WITNESS_FS_TRUNCATE:   return "TRUNCATE";
        case WITNESS_FS_DELETE:     return "DELETE";
        case WITNESS_FS_RENAME:     return "RENAME";
        case WITNESS_FS_MKDIR:      return "MKDIR";
        case WITNESS_FS_RMDIR:      return "RMDIR";
        case WITNESS_FS_MMAP_WRITE: return "MMAP_WRITE";
        case WITNESS_FS_IO_URING:   return "IO_URING";
        default:                    return "OPENAT";
    }
}

uint32_t fs_op_from_string(std::string_view s) {
    if (s == "OPENAT")     return WITNESS_FS_OPENAT;
    if (s == "CREATE")     return WITNESS_FS_CREATE;
    if (s == "MODIFY")     return WITNESS_FS_MODIFY;
    if (s == "TRUNCATE")   return WITNESS_FS_TRUNCATE;
    if (s == "DELETE")     return WITNESS_FS_DELETE;
    if (s == "RENAME")     return WITNESS_FS_RENAME;
    if (s == "MKDIR")      return WITNESS_FS_MKDIR;
    if (s == "RMDIR")      return WITNESS_FS_RMDIR;
    if (s == "MMAP_WRITE") return WITNESS_FS_MMAP_WRITE;
    if (s == "IO_URING")   return WITNESS_FS_IO_URING;
    throw std::runtime_error("invalid filesystem op: " + std::string(s));
}

std::string phase_to_string(uint32_t phase) {
    switch (phase) {
        case WITNESS_PHASE_ATTEMPTED:    return "attempted";
        case WITNESS_PHASE_COMPLETED:    return "completed";
        case WITNESS_PHASE_STATE_CHANGE: return "state_change";
        default:                         return "completed";
    }
}

uint32_t phase_from_string(std::string_view s) {
    if (s == "attempted")    return WITNESS_PHASE_ATTEMPTED;
    if (s == "completed")    return WITNESS_PHASE_COMPLETED;
    if (s == "state_change") return WITNESS_PHASE_STATE_CHANGE;
    throw std::runtime_error("invalid phase: " + std::string(s));
}

std::string net_op_to_string(uint32_t op) {
    switch (op) {
        case WITNESS_NET_CONNECT:      return "CONNECT";
        case WITNESS_NET_SENDMSG:      return "SENDMSG";
        case WITNESS_NET_STATE_CHANGE: return "STATE_CHANGE";
        default:                       return "CONNECT";
    }
}

uint32_t net_op_from_string(std::string_view s) {
    if (s == "CONNECT")      return WITNESS_NET_CONNECT;
    if (s == "SENDMSG")      return WITNESS_NET_SENDMSG;
    if (s == "STATE_CHANGE") return WITNESS_NET_STATE_CHANGE;
    throw std::runtime_error("invalid network op: " + std::string(s));
}

std::string net_outcome_to_string(uint32_t outcome) {
    switch (outcome) {
        case WITNESS_NET_OUTCOME_ATTEMPTED:   return "attempted";
        case WITNESS_NET_OUTCOME_CONNECTED:   return "connected";
        case WITNESS_NET_OUTCOME_REFUSED:     return "refused";
        case WITNESS_NET_OUTCOME_TIMED_OUT:   return "timed_out";
        case WITNESS_NET_OUTCOME_UNREACHABLE: return "unreachable";
        case WITNESS_NET_OUTCOME_IN_PROGRESS: return "in_progress";
        case WITNESS_NET_OUTCOME_FAILED:      return "failed";
        case WITNESS_NET_OUTCOME_INCOMPLETE:  return "incomplete";
        default:                              return "failed";
    }
}

uint32_t net_outcome_from_string(std::string_view s) {
    if (s == "attempted")   return WITNESS_NET_OUTCOME_ATTEMPTED;
    if (s == "connected")   return WITNESS_NET_OUTCOME_CONNECTED;
    if (s == "refused")     return WITNESS_NET_OUTCOME_REFUSED;
    if (s == "timed_out")   return WITNESS_NET_OUTCOME_TIMED_OUT;
    if (s == "unreachable") return WITNESS_NET_OUTCOME_UNREACHABLE;
    if (s == "in_progress") return WITNESS_NET_OUTCOME_IN_PROGRESS;
    if (s == "failed")      return WITNESS_NET_OUTCOME_FAILED;
    if (s == "incomplete")  return WITNESS_NET_OUTCOME_INCOMPLETE;
    throw std::runtime_error("invalid network outcome: " + std::string(s));
}

std::string tcp_state_to_string(uint8_t st) {
    switch (st) {
        case 1:  return "TCP_ESTABLISHED";
        case 2:  return "TCP_SYN_SENT";
        case 3:  return "TCP_SYN_RECV";
        case 4:  return "TCP_FIN_WAIT1";
        case 5:  return "TCP_FIN_WAIT2";
        case 6:  return "TCP_TIME_WAIT";
        case 7:  return "TCP_CLOSE";
        case 8:  return "TCP_CLOSE_WAIT";
        case 9:  return "TCP_LAST_ACK";
        case 10: return "TCP_LISTEN";
        case 11: return "TCP_CLOSING";
        default: return "TCP_UNKNOWN";
    }
}

JsonValue observed_event_to_json(const ObservedEvent& ev) {
    JsonObject obj;
    obj["seq"] = ev.seq;
    obj["timestampNs"] = ev.timestamp_ns;
    obj["cgroupId"] = ev.cgroup_id;
    obj["eventType"] = event_type_to_string(ev.event_type);
    obj["pid"] = static_cast<uint64_t>(ev.pid);
    obj["tgid"] = static_cast<uint64_t>(ev.tgid);
    obj["ppid"] = static_cast<uint64_t>(ev.ppid);
    obj["childPid"] = static_cast<uint64_t>(ev.child_pid);
    obj["childTgid"] = static_cast<uint64_t>(ev.child_tgid);
    obj["uid"] = static_cast<uint64_t>(ev.uid);
    obj["gid"] = static_cast<uint64_t>(ev.gid);
    obj["exitCode"] = static_cast<int64_t>(ev.exit_code);
    obj["comm"] = sanitize_utf8(ev.comm, 16);
    return JsonValue(std::move(obj));
}

namespace {

const JsonValue& require_field(const JsonObject& obj, const std::string& key) {
    auto it = obj.find(key);
    if (it == obj.end()) {
        throw std::runtime_error("missing required field: " + key);
    }
    return it->second;
}

uint64_t opt_uint64(const JsonObject& obj, const std::string& key, uint64_t def = 0) {
    auto it = obj.find(key);
    if (it == obj.end() || it->second.is_null()) return def;
    return it->second.as_uint64();
}

int64_t opt_int64(const JsonObject& obj, const std::string& key, int64_t def = 0) {
    auto it = obj.find(key);
    if (it == obj.end() || it->second.is_null()) return def;
    return it->second.as_int64();
}

std::string opt_string(const JsonObject& obj, const std::string& key, const std::string& def = "") {
    auto it = obj.find(key);
    if (it == obj.end() || it->second.is_null()) return def;
    return it->second.as_string();
}

void push_unique(std::vector<std::string>& vec, const std::string& val) {
    if (std::find(vec.begin(), vec.end(), val) == vec.end()) {
        vec.push_back(val);
    }
}

} // namespace

ObservedEvent observed_event_from_json(const JsonValue& v) {
    const auto& obj = v.as_object();
    ObservedEvent ev;
    ev.seq = require_field(obj, "seq").as_uint64();
    ev.timestamp_ns = require_field(obj, "timestampNs").as_uint64();
    ev.cgroup_id = require_field(obj, "cgroupId").as_uint64();
    ev.event_type = event_type_from_string(require_field(obj, "eventType").as_string());
    ev.pid = static_cast<uint32_t>(require_field(obj, "pid").as_uint64());
    ev.tgid = static_cast<uint32_t>(require_field(obj, "tgid").as_uint64());
    ev.ppid = static_cast<uint32_t>(opt_uint64(obj, "ppid", 0));
    ev.child_pid = static_cast<uint32_t>(opt_uint64(obj, "childPid", 0));
    ev.child_tgid = static_cast<uint32_t>(opt_uint64(obj, "childTgid", 0));
    ev.uid = static_cast<uint32_t>(opt_uint64(obj, "uid", 0));
    ev.gid = static_cast<uint32_t>(opt_uint64(obj, "gid", 0));
    ev.exit_code = static_cast<int32_t>(opt_int64(obj, "exitCode", 0));
    std::string raw_comm = require_field(obj, "comm").as_string();
    if (raw_comm.size() > 16) {
        throw std::runtime_error("comm exceeds bounded 16-byte limit");
    }
    ev.comm = sanitize_utf8(raw_comm, 16);
    if (ev.seq == 0) {
        throw std::runtime_error("event seq must be >= 1");
    }
    if (ev.pid == 0 && ev.tgid == 0) {
        throw std::runtime_error("event pid/tgid cannot both be 0");
    }

    if (ev.event_type == EventType::Fs) {
        std::string op_s = opt_string(obj, "op", "OPENAT");
        ev.op = fs_op_from_string(op_s);
        std::string ph_s = opt_string(obj, "phase", "completed");
        ev.phase = phase_from_string(ph_s);
        ev.result_errno = static_cast<int32_t>(opt_int64(obj, "resultErrno", 0));
        ev.bytes = opt_uint64(obj, "bytes", 0);
        ev.flags = opt_uint64(obj, "flags", 0);
        ev.dev = opt_uint64(obj, "dev", 0);
        ev.inode = opt_uint64(obj, "inode", 0);
        ev.target_inode = opt_uint64(obj, "targetInode", 0);
        ev.mount_id = static_cast<uint32_t>(opt_uint64(obj, "mountId", 0));
        ev.path = sanitize_utf8(opt_string(obj, "path", ""), 127);
        ev.target_path = sanitize_utf8(opt_string(obj, "targetPath", ""), 127);
    } else if (ev.event_type == EventType::Net) {
        std::string op_s = opt_string(obj, "op", "CONNECT");
        ev.op = net_op_from_string(op_s);
        std::string ph_s = opt_string(obj, "phase", "completed");
        ev.phase = phase_from_string(ph_s);
        std::string out_s = opt_string(obj, "outcome", "connected");
        ev.outcome = net_outcome_from_string(out_s);
        ev.result_errno = static_cast<int32_t>(opt_int64(obj, "errnoVal", opt_int64(obj, "resultErrno", 0)));
        ev.sock_cookie = opt_uint64(obj, "sockCookie", 0);
        std::string af_s = opt_string(obj, "af", "INET");
        ev.af = (af_s == "INET6") ? AF_INET6 : AF_INET;
        std::string proto_s = opt_string(obj, "proto", "TCP");
        ev.proto = (proto_s == "UDP") ? IPPROTO_UDP : IPPROTO_TCP;
        ev.local_port = static_cast<uint16_t>(opt_uint64(obj, "localPort", 0));
        ev.remote_port = static_cast<uint16_t>(opt_uint64(obj, "remotePort", 0));
        ev.old_state = static_cast<uint8_t>(opt_uint64(obj, "oldState", 0));
        ev.new_state = static_cast<uint8_t>(opt_uint64(obj, "newState", 0));
        ev.bytes = opt_uint64(obj, "bytes", 0);
        ev.remote_addr_override = opt_string(obj, "remoteAddr", "");
        if (!ev.remote_addr_override.empty()) {
            if (ev.af == AF_INET) {
                inet_pton(AF_INET, ev.remote_addr_override.c_str(), &ev.remote_ip4);
            } else {
                inet_pton(AF_INET6, ev.remote_addr_override.c_str(), ev.remote_ip6.data());
            }
        }
    }

    return ev;
}

JsonValue process_node_to_json(const ProcessNode& node) {
    JsonObject obj;
    obj["pid"] = static_cast<uint64_t>(node.pid);
    obj["tgid"] = static_cast<uint64_t>(node.tgid);
    obj["ppid"] = static_cast<uint64_t>(node.ppid);
    obj["comm"] = sanitize_utf8(node.comm, 16);
    obj["uid"] = static_cast<uint64_t>(node.uid);
    obj["gid"] = static_cast<uint64_t>(node.gid);
    obj["forkedAtNs"] = node.forked_at_ns;
    obj["execedAtNs"] = node.execed_at_ns;
    obj["exitedAtNs"] = node.exited_at_ns;
    obj["exitCode"] = static_cast<int64_t>(node.exit_code);
    JsonArray children;
    children.reserve(node.children.size());
    for (const auto& c : node.children) {
        children.push_back(process_node_to_json(c));
    }
    obj["children"] = JsonValue(std::move(children));
    return JsonValue(std::move(obj));
}

JsonValue filesystem_event_to_json(const FilesystemEvent& ev) {
    JsonObject obj;
    obj["seq"] = ev.seq;
    obj["timestampNs"] = ev.timestamp_ns;
    obj["cgroupId"] = ev.cgroup_id;
    obj["pid"] = static_cast<uint64_t>(ev.pid);
    obj["tgid"] = static_cast<uint64_t>(ev.tgid);
    obj["comm"] = sanitize_utf8(ev.comm, 16);
    obj["uid"] = static_cast<uint64_t>(ev.uid);
    obj["gid"] = static_cast<uint64_t>(ev.gid);
    obj["op"] = ev.op;
    obj["phase"] = ev.phase;
    obj["succeeded"] = ev.succeeded;
    obj["resultErrno"] = static_cast<int64_t>(ev.result_errno);
    obj["bytes"] = ev.bytes;
    obj["flags"] = ev.flags;
    obj["dev"] = ev.dev;
    obj["inode"] = ev.inode;
    obj["mountId"] = static_cast<uint64_t>(ev.mount_id);
    obj["pathDigest"] = ev.path_digest;
    obj["pathDigestKeyId"] = ev.path_digest_key_id;
    obj["displayPath"] = ev.display_path.has_value()
        ? JsonValue(sanitize_utf8(*ev.display_path))
        : JsonValue(nullptr);
    obj["targetPathDigest"] = ev.target_path_digest.has_value()
        ? JsonValue(*ev.target_path_digest)
        : JsonValue(nullptr);
    obj["targetDisplayPath"] = ev.target_display_path.has_value()
        ? JsonValue(sanitize_utf8(*ev.target_display_path))
        : JsonValue(nullptr);
    obj["targetInode"] = ev.target_inode;
    return JsonValue(std::move(obj));
}

FilesystemEvent filesystem_event_from_json(const JsonValue& v) {
    const auto& obj = v.as_object();
    FilesystemEvent ev;
    ev.seq = require_field(obj, "seq").as_uint64();
    ev.timestamp_ns = require_field(obj, "timestampNs").as_uint64();
    ev.cgroup_id = require_field(obj, "cgroupId").as_uint64();
    ev.pid = static_cast<uint32_t>(require_field(obj, "pid").as_uint64());
    ev.tgid = static_cast<uint32_t>(require_field(obj, "tgid").as_uint64());
    ev.comm = sanitize_utf8(require_field(obj, "comm").as_string(), 16);
    ev.uid = static_cast<uint32_t>(require_field(obj, "uid").as_uint64());
    ev.gid = static_cast<uint32_t>(require_field(obj, "gid").as_uint64());
    ev.op = require_field(obj, "op").as_string();
    ev.phase = require_field(obj, "phase").as_string();
    ev.succeeded = require_field(obj, "succeeded").as_bool();
    ev.result_errno = static_cast<int32_t>(require_field(obj, "resultErrno").as_int64());
    ev.bytes = require_field(obj, "bytes").as_uint64();
    ev.flags = require_field(obj, "flags").as_uint64();
    ev.dev = require_field(obj, "dev").as_uint64();
    ev.inode = require_field(obj, "inode").as_uint64();
    ev.mount_id = static_cast<uint32_t>(require_field(obj, "mountId").as_uint64());
    ev.path_digest = require_field(obj, "pathDigest").as_string();
    ev.path_digest_key_id = require_field(obj, "pathDigestKeyId").as_string();
    auto dp_it = obj.find("displayPath");
    if (dp_it != obj.end() && dp_it->second.is_string()) ev.display_path = dp_it->second.as_string();
    auto tpd_it = obj.find("targetPathDigest");
    if (tpd_it != obj.end() && tpd_it->second.is_string()) ev.target_path_digest = tpd_it->second.as_string();
    auto tdp_it = obj.find("targetDisplayPath");
    if (tdp_it != obj.end() && tdp_it->second.is_string()) ev.target_display_path = tdp_it->second.as_string();
    ev.target_inode = require_field(obj, "targetInode").as_uint64();
    return ev;
}

JsonValue network_event_to_json(const NetworkEvent& ev) {
    JsonObject obj;
    obj["seq"] = ev.seq;
    obj["timestampNs"] = ev.timestamp_ns;
    obj["cgroupId"] = ev.cgroup_id;
    obj["pid"] = static_cast<uint64_t>(ev.pid);
    obj["tgid"] = static_cast<uint64_t>(ev.tgid);
    obj["comm"] = sanitize_utf8(ev.comm, 16);
    obj["sockCookie"] = ev.sock_cookie;
    obj["af"] = ev.af;
    obj["proto"] = ev.proto;
    obj["op"] = ev.op;
    obj["phase"] = ev.phase;
    obj["stateTransition"] = ev.state_transition.has_value()
        ? JsonValue(*ev.state_transition)
        : JsonValue(nullptr);
    obj["outcome"] = ev.outcome;
    obj["errnoVal"] = static_cast<int64_t>(ev.errno_val);
    obj["remoteAddrDigest"] = ev.remote_addr_digest;
    obj["displayRemoteAddr"] = ev.display_remote_addr.has_value()
        ? JsonValue(*ev.display_remote_addr)
        : JsonValue(nullptr);
    obj["remotePort"] = static_cast<uint64_t>(ev.remote_port);
    obj["localPort"] = static_cast<uint64_t>(ev.local_port);
    obj["bytes"] = ev.bytes;
    return JsonValue(std::move(obj));
}

NetworkEvent network_event_from_json(const JsonValue& v) {
    const auto& obj = v.as_object();
    NetworkEvent ev;
    ev.seq = require_field(obj, "seq").as_uint64();
    ev.timestamp_ns = require_field(obj, "timestampNs").as_uint64();
    ev.cgroup_id = require_field(obj, "cgroupId").as_uint64();
    ev.pid = static_cast<uint32_t>(require_field(obj, "pid").as_uint64());
    ev.tgid = static_cast<uint32_t>(require_field(obj, "tgid").as_uint64());
    ev.comm = sanitize_utf8(require_field(obj, "comm").as_string(), 16);
    ev.sock_cookie = require_field(obj, "sockCookie").as_uint64();
    ev.af = require_field(obj, "af").as_string();
    ev.proto = require_field(obj, "proto").as_string();
    ev.op = require_field(obj, "op").as_string();
    ev.phase = require_field(obj, "phase").as_string();
    auto st_it = obj.find("stateTransition");
    if (st_it != obj.end() && st_it->second.is_string()) ev.state_transition = st_it->second.as_string();
    ev.outcome = require_field(obj, "outcome").as_string();
    ev.errno_val = static_cast<int32_t>(require_field(obj, "errnoVal").as_int64());
    ev.remote_addr_digest = require_field(obj, "remoteAddrDigest").as_string();
    auto dra_it = obj.find("displayRemoteAddr");
    if (dra_it != obj.end() && dra_it->second.is_string()) ev.display_remote_addr = dra_it->second.as_string();
    ev.remote_port = static_cast<uint16_t>(require_field(obj, "remotePort").as_uint64());
    ev.local_port = static_cast<uint16_t>(require_field(obj, "localPort").as_uint64());
    ev.bytes = require_field(obj, "bytes").as_uint64();
    return ev;
}

JsonValue observation_scope_to_json(const ObservationScope& scope) {
    auto to_arr = [](const std::vector<std::string>& v) {
        JsonArray arr;
        arr.reserve(v.size());
        for (const auto& s : v) arr.emplace_back(s);
        return JsonValue(std::move(arr));
    };
    JsonObject obj;
    obj["policyRequired"] = to_arr(scope.policy_required);
    obj["requested"] = to_arr(scope.requested);
    obj["active"] = to_arr(scope.active);
    return JsonValue(std::move(obj));
}

JsonValue category_status_to_json(const CategoryStatus& st) {
    JsonObject obj;
    obj["category"] = st.category;
    obj["enabled"] = st.enabled;
    obj["status"] = st.status;
    obj["eventCount"] = st.event_count;
    obj["droppedEvents"] = st.dropped_events;
    obj["sequenceGaps"] = st.sequence_gaps;
    obj["firstSeq"] = st.first_seq.has_value() ? JsonValue(*st.first_seq) : JsonValue(nullptr);
    obj["lastSeq"] = st.last_seq.has_value() ? JsonValue(*st.last_seq) : JsonValue(nullptr);
    obj["categoryDigestSha256"] = st.category_digest_sha256;
    JsonArray reasons;
    for (const auto& r : st.incomplete_reasons) reasons.emplace_back(r);
    obj["incompleteReasons"] = JsonValue(std::move(reasons));
    JsonArray unsup;
    for (const auto& u : st.unsupported_operations) unsup.emplace_back(u);
    obj["unsupportedOperations"] = JsonValue(std::move(unsup));
    return JsonValue(std::move(obj));
}

JsonValue category_completeness_to_json(const CategoryCompleteness& cc) {
    JsonObject obj;
    obj["process"] = category_status_to_json(cc.process);
    obj["filesystem"] = category_status_to_json(cc.filesystem);
    obj["network"] = category_status_to_json(cc.network);
    return JsonValue(std::move(obj));
}

std::string compute_process_category_digest(const std::vector<ProcessNode>& tree) {
    JsonArray arr;
    arr.reserve(tree.size());
    for (const auto& n : tree) arr.push_back(process_node_to_json(n));
    return sha256_hex("jc.kernel-witness.category.process.v2:" + serialize_canonical_json(JsonValue(std::move(arr))));
}

std::string compute_filesystem_category_digest(const std::vector<FilesystemEvent>& fs_events) {
    JsonArray arr;
    arr.reserve(fs_events.size());
    for (const auto& e : fs_events) arr.push_back(filesystem_event_to_json(e));
    return sha256_hex("jc.kernel-witness.category.filesystem.v2:" + serialize_canonical_json(JsonValue(std::move(arr))));
}

std::string compute_network_category_digest(const std::vector<NetworkEvent>& net_events) {
    JsonArray arr;
    arr.reserve(net_events.size());
    for (const auto& e : net_events) arr.push_back(network_event_to_json(e));
    return sha256_hex("jc.kernel-witness.category.network.v2:" + serialize_canonical_json(JsonValue(std::move(arr))));
}

std::vector<ObservedEvent> parse_events_jsonl(std::string_view jsonl, std::vector<std::string>& errors) {
    std::vector<ObservedEvent> events;
    size_t pos = 0;
    size_t line_no = 0;
    while (pos < jsonl.size()) {
        size_t nl = jsonl.find('\n', pos);
        if (nl == std::string_view::npos) nl = jsonl.size();
        std::string_view line = jsonl.substr(pos, nl - pos);
        pos = nl + 1;
        ++line_no;

        while (!line.empty() && (line.front() == ' ' || line.front() == '\t' || line.front() == '\r')) {
            line.remove_prefix(1);
        }
        while (!line.empty() && (line.back() == ' ' || line.back() == '\t' || line.back() == '\r')) {
            line.remove_suffix(1);
        }
        if (line.empty()) continue;

        try {
            JsonValue v = parse_json(line);
            events.push_back(observed_event_from_json(v));
        } catch (const std::exception& ex) {
            errors.push_back("malformed_event_line_" + std::to_string(line_no) + ": " + ex.what());
        }
    }
    return events;
}

ReconstructionResult reconstruct_process_tree(
    const std::vector<ObservedEvent>& raw_events,
    uint64_t target_cgroup_id,
    uint32_t root_pid,
    const ReconstructionOptions& opts)
{
    ReconstructionResult res;
    res.root_pid = root_pid;

    std::string hmac_key = opts.hmac_key.empty() ? "jc-witness-default-path-hmac-key-v2" : opts.hmac_key;
    std::string hmac_key_id = opts.hmac_key_id.empty()
        ? ("hmac-sha256:" + sha256_hex(hmac_key).substr(0, 16))
        : opts.hmac_key_id;

    std::vector<ObservedEvent> matched_events;
    for (const auto& ev : raw_events) {
        if (ev.cgroup_id != target_cgroup_id) {
            ++res.excluded_unrelated_cgroup_events;
            continue;
        }
        matched_events.push_back(ev);
    }

    std::sort(matched_events.begin(), matched_events.end(), [](const ObservedEvent& a, const ObservedEvent& b) {
        if (a.seq != b.seq) return a.seq < b.seq;
        return a.timestamp_ns < b.timestamp_ns;
    });

    std::map<uint32_t, ProcessNode> nodes;
    std::map<uint32_t, std::vector<uint32_t>> children_by_parent;
    std::set<uint32_t> known_pids;
    std::map<std::pair<uint64_t, uint64_t>, std::string> inode_path_table;
    std::map<uint32_t, std::string> pending_fs_attempts_by_pid;

    struct SockTrack {
        size_t last_event_idx{0};
        std::string last_outcome;
    };
    std::map<uint64_t, SockTrack> active_tcp_socks;

    auto ensure_node = [&](uint32_t tgid, uint32_t pid) -> ProcessNode& {
        uint32_t key = tgid != 0 ? tgid : pid;
        auto [it, inserted] = nodes.try_emplace(key);
        if (inserted) {
            it->second.pid = pid != 0 ? pid : key;
            it->second.tgid = key;
            known_pids.insert(key);
        }
        return it->second;
    };

    auto touch_category_seq = [](CategoryStatus& cs, uint64_t seq) {
        ++cs.event_count;
        if (!cs.first_seq.has_value() || seq < *cs.first_seq) cs.first_seq = seq;
        if (!cs.last_seq.has_value() || seq > *cs.last_seq) cs.last_seq = seq;
    };

    uint64_t prev_seq = 0;
    for (const auto& orig_ev : matched_events) {
        ObservedEvent ev = orig_ev;
        ev.comm = sanitize_utf8(ev.comm, 16);
        ev.path = sanitize_utf8(ev.path, 127);
        ev.target_path = sanitize_utf8(ev.target_path, 127);

        if (ev.seq == 0) {
            res.anomalies.push_back("invalid_zero_sequence");
        } else {
            if (prev_seq == 0 && ev.seq > 1) {
                res.sequence_gaps += (ev.seq - 1);
            } else if (prev_seq != 0 && ev.seq > prev_seq + 1) {
                res.sequence_gaps += (ev.seq - prev_seq - 1);
            } else if (prev_seq != 0 && ev.seq == prev_seq) {
                res.anomalies.push_back("duplicate_sequence");
            }
            prev_seq = ev.seq;
        }

        if (res.start_time_ns == 0 || (ev.timestamp_ns != 0 && ev.timestamp_ns < res.start_time_ns)) {
            res.start_time_ns = ev.timestamp_ns;
        }
        if (ev.timestamp_ns > res.end_time_ns) {
            res.end_time_ns = ev.timestamp_ns;
        }

        ++res.counts.total;
        uint32_t key = ev.tgid != 0 ? ev.tgid : ev.pid;

        switch (ev.event_type) {
            case EventType::Fork: {
                res.events.push_back(ev);
                ++res.counts.fork;
                touch_category_seq(res.category_completeness.process, ev.seq);

                uint32_t child_key = ev.child_tgid != 0 ? ev.child_tgid : ev.child_pid;
                bool is_thread_clone = (child_key == key && ev.child_pid != child_key);
                if (is_thread_clone) {
                    break;
                }

                bool is_external_root_fork = (root_pid != 0 && child_key == root_pid && key != root_pid);
                if (!is_external_root_fork) {
                    ProcessNode& parent = ensure_node(key, ev.pid);
                    if (parent.ppid == 0 && ev.ppid != 0) parent.ppid = ev.ppid;
                    if (parent.comm.empty() && !ev.comm.empty()) parent.comm = ev.comm;
                    parent.uid = ev.uid;
                    parent.gid = ev.gid;
                }

                if (child_key != 0) {
                    ProcessNode& child = ensure_node(child_key, ev.child_pid);
                    child.ppid = key;
                    child.uid = ev.uid;
                    child.gid = ev.gid;
                    if (child.forked_at_ns == 0) child.forked_at_ns = ev.timestamp_ns;
                    if (!is_external_root_fork && child_key != key) {
                        auto& vec = children_by_parent[key];
                        if (std::find(vec.begin(), vec.end(), child_key) == vec.end()) {
                            vec.push_back(child_key);
                        }
                    }
                }
                break;
            }
            case EventType::Exec: {
                res.events.push_back(ev);
                ++res.counts.exec;
                touch_category_seq(res.category_completeness.process, ev.seq);

                ProcessNode& proc = ensure_node(key, ev.pid);
                if (proc.ppid == 0 && ev.ppid != 0) proc.ppid = ev.ppid;
                proc.comm = ev.comm;
                proc.uid = ev.uid;
                proc.gid = ev.gid;
                if (proc.execed_at_ns == 0) proc.execed_at_ns = ev.timestamp_ns;
                if (ev.ppid != 0 && ev.ppid != key && known_pids.count(ev.ppid)) {
                    auto& vec = children_by_parent[ev.ppid];
                    if (std::find(vec.begin(), vec.end(), key) == vec.end()) {
                        vec.push_back(key);
                    }
                }
                break;
            }
            case EventType::Exit: {
                res.events.push_back(ev);
                ++res.counts.exit;
                touch_category_seq(res.category_completeness.process, ev.seq);

                /* Ignore non-leader thread exits so they do not clobber thread-group leader exit_code */
                if (ev.tgid != 0 && ev.pid != 0 && ev.pid != ev.tgid) {
                    break;
                }

                ProcessNode& proc = ensure_node(key, ev.pid);
                if (proc.ppid == 0 && ev.ppid != 0) proc.ppid = ev.ppid;
                if (proc.comm.empty() && !ev.comm.empty()) proc.comm = ev.comm;
                proc.uid = ev.uid;
                proc.gid = ev.gid;
                proc.exited_at_ns = ev.timestamp_ns;
                proc.exit_code = ev.exit_code;
                break;
            }
            case EventType::Fs: {
                ++res.counts.filesystem;
                touch_category_seq(res.category_completeness.filesystem, ev.seq);

                FilesystemEvent fev;
                fev.seq = ev.seq;
                fev.timestamp_ns = ev.timestamp_ns;
                fev.cgroup_id = ev.cgroup_id;
                fev.pid = ev.pid;
                fev.tgid = ev.tgid;
                fev.comm = ev.comm;
                fev.uid = ev.uid;
                fev.gid = ev.gid;
                fev.op = fs_op_to_string(ev.op);
                fev.phase = phase_to_string(ev.phase);
                fev.result_errno = ev.result_errno;
                fev.succeeded = (fev.phase == "completed" && ev.result_errno == 0);
                fev.bytes = ev.bytes;
                fev.flags = ev.flags;
                fev.dev = ev.dev;
                fev.inode = ev.inode;
                fev.mount_id = ev.mount_id;
                fev.target_inode = ev.target_inode;
                fev.path_digest_key_id = hmac_key_id;

                std::string eff_path = ev.path;
                if (fev.inode != 0 && (eff_path.empty() || eff_path.find('/') == std::string::npos)) {
                    auto it = inode_path_table.find({fev.dev, fev.inode});
                    if (it != inode_path_table.end() && !it->second.empty()) {
                        eff_path = it->second;
                    }
                }
                if (fev.succeeded && fev.inode != 0 && !eff_path.empty()) {
                    inode_path_table[{fev.dev, fev.inode}] = eff_path;
                }
                if (fev.op == "RENAME" && fev.succeeded && fev.inode != 0 && !ev.target_path.empty()) {
                    inode_path_table[{fev.dev, fev.inode}] = ev.target_path;
                }

                fev.path_digest = hmac_sha256_hex(hmac_key, "jc.kernel-witness.fs.path.v2:" + eff_path);
                if (opts.include_display_paths) {
                    fev.display_path = eff_path;
                }

                if (fev.op == "RENAME" || !ev.target_path.empty()) {
                    fev.target_path_digest = hmac_sha256_hex(hmac_key, "jc.kernel-witness.fs.path.v2:" + ev.target_path);
                    if (opts.include_display_paths) {
                        fev.target_display_path = ev.target_path;
                    }
                }

                if (fev.op == "MMAP_WRITE") {
                    push_unique(res.category_completeness.filesystem.unsupported_operations, "mmap_shared_write");
                    push_unique(res.category_completeness.filesystem.incomplete_reasons, "mmap_shared_write_observed_post_map_mutations_untracked");
                    if (res.category_completeness.filesystem.status == "complete") {
                        res.category_completeness.filesystem.status = "partial";
                    }
                } else if (fev.op == "IO_URING") {
                    push_unique(res.category_completeness.filesystem.unsupported_operations, "io_uring");
                    push_unique(res.category_completeness.filesystem.incomplete_reasons, "io_uring_sqe_mutations_untracked");
                    if (res.category_completeness.filesystem.status == "complete") {
                        res.category_completeness.filesystem.status = "partial";
                    }
                } else if (fev.phase == "attempted") {
                    pending_fs_attempts_by_pid[fev.pid] = fev.op;
                } else if (fev.phase == "completed") {
                    pending_fs_attempts_by_pid.erase(fev.pid);
                }

                res.filesystem_events.push_back(std::move(fev));
                break;
            }
            case EventType::Net: {
                ++res.counts.network;
                touch_category_seq(res.category_completeness.network, ev.seq);

                NetworkEvent nev;
                nev.seq = ev.seq;
                nev.timestamp_ns = ev.timestamp_ns;
                nev.cgroup_id = ev.cgroup_id;
                nev.pid = ev.pid;
                nev.tgid = ev.tgid;
                nev.comm = ev.comm;
                nev.sock_cookie = ev.sock_cookie;
                nev.af = (ev.af == AF_INET6) ? "INET6" : "INET";
                nev.proto = (ev.proto == IPPROTO_UDP) ? "UDP" : "TCP";
                nev.op = net_op_to_string(ev.op);
                nev.phase = phase_to_string(ev.phase);
                nev.outcome = net_outcome_to_string(ev.outcome);
                nev.errno_val = ev.result_errno;
                nev.remote_port = ev.remote_port;
                nev.local_port = ev.local_port;
                nev.bytes = ev.bytes;

                if (nev.phase == "state_change") {
                    nev.state_transition = tcp_state_to_string(ev.old_state) + "->" + tcp_state_to_string(ev.new_state);
                }

                std::string addr_str = ev.remote_addr_override;
                if (addr_str.empty()) {
                    char addr_buf[INET6_ADDRSTRLEN]{};
                    if (ev.af == AF_INET6) {
                        if (inet_ntop(AF_INET6, ev.remote_ip6.data(), addr_buf, sizeof(addr_buf))) {
                            addr_str = addr_buf;
                        } else {
                            addr_str = "::";
                        }
                    } else {
                        if (inet_ntop(AF_INET, &ev.remote_ip4, addr_buf, sizeof(addr_buf))) {
                            addr_str = addr_buf;
                        } else {
                            addr_str = "0.0.0.0";
                        }
                    }
                }

                nev.remote_addr_digest = hmac_sha256_hex(
                    hmac_key,
                    "jc.kernel-witness.net.addr.v2:" + addr_str + ":" + std::to_string(nev.remote_port));
                if (opts.include_display_remote_addrs || opts.include_display_paths) {
                    nev.display_remote_addr = addr_str;
                }

                size_t cur_idx = res.network_events.size();
                if (nev.proto == "TCP" && nev.sock_cookie != 0) {
                    active_tcp_socks[nev.sock_cookie] = SockTrack{
                        .last_event_idx = cur_idx,
                        .last_outcome = nev.outcome,
                    };
                }
                res.network_events.push_back(std::move(nev));
                break;
            }
        }
    }

    if (!pending_fs_attempts_by_pid.empty()) {
        push_unique(res.category_completeness.filesystem.incomplete_reasons, "in_flight_filesystem_operation_at_exit");
        if (res.category_completeness.filesystem.status == "complete") {
            res.category_completeness.filesystem.status = "partial";
        }
    }

    for (const auto& [cookie, st] : active_tcp_socks) {
        if (st.last_outcome == "attempted" || st.last_outcome == "in_progress") {
            if (st.last_event_idx < res.network_events.size()) {
                res.network_events[st.last_event_idx].outcome = "incomplete";
            }
            push_unique(res.category_completeness.network.incomplete_reasons, "in_flight_network_connection_at_exit");
            if (res.category_completeness.network.status == "complete") {
                res.category_completeness.network.status = "partial";
            }
        }
    }

    if (res.sequence_gaps > 0) {
        res.anomalies.push_back("sequence_gap_detected");
        res.category_completeness.process.sequence_gaps = res.sequence_gaps;
        res.category_completeness.process.status = "incomplete";
        push_unique(res.category_completeness.process.incomplete_reasons, "sequence_gap_detected");
    }

    std::set<uint32_t> visited;
    auto build_subtree = [&](auto& self, uint32_t pid_key) -> ProcessNode {
        visited.insert(pid_key);
        ProcessNode node = nodes.at(pid_key);
        auto it = children_by_parent.find(pid_key);
        if (it != children_by_parent.end()) {
            for (uint32_t child_key : it->second) {
                if (!visited.count(child_key) && nodes.count(child_key)) {
                    node.children.push_back(self(self, child_key));
                }
            }
        }
        return node;
    };

    for (const auto& [pid_key, node] : nodes) {
        if (node.ppid == 0 || !known_pids.count(node.ppid)) {
            if (!visited.count(pid_key)) {
                res.process_tree.push_back(build_subtree(build_subtree, pid_key));
            }
        }
    }

    for (const auto& [pid_key, node] : nodes) {
        if (!visited.count(pid_key)) {
            res.process_tree.push_back(build_subtree(build_subtree, pid_key));
        }
    }

    if (res.root_pid == 0 && !res.process_tree.empty()) {
        res.root_pid = res.process_tree[0].tgid;
    }

    res.category_completeness.process.category_digest_sha256 = compute_process_category_digest(res.process_tree);
    res.category_completeness.filesystem.category_digest_sha256 = compute_filesystem_category_digest(res.filesystem_events);
    res.category_completeness.network.category_digest_sha256 = compute_network_category_digest(res.network_events);

    return res;
}

} // namespace jc::witness
