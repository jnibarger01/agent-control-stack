#include "witness/process_tree.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <stdexcept>

namespace jc::witness {

std::string event_type_to_string(EventType t) {
    switch (t) {
        case EventType::Fork: return "FORK";
        case EventType::Exec: return "EXEC";
        case EventType::Exit: return "EXIT";
    }
    throw std::runtime_error("unknown EventType");
}

EventType event_type_from_string(std::string_view s) {
    if (s == "FORK") return EventType::Fork;
    if (s == "EXEC") return EventType::Exec;
    if (s == "EXIT") return EventType::Exit;
    throw std::runtime_error("invalid eventType: " + std::string(s));
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
    obj["comm"] = ev.comm;
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
    ev.ppid = static_cast<uint32_t>(require_field(obj, "ppid").as_uint64());
    ev.child_pid = static_cast<uint32_t>(require_field(obj, "childPid").as_uint64());
    ev.child_tgid = static_cast<uint32_t>(require_field(obj, "childTgid").as_uint64());
    ev.uid = static_cast<uint32_t>(require_field(obj, "uid").as_uint64());
    ev.gid = static_cast<uint32_t>(require_field(obj, "gid").as_uint64());
    ev.exit_code = static_cast<int32_t>(require_field(obj, "exitCode").as_int64());
    ev.comm = require_field(obj, "comm").as_string();
    if (ev.comm.size() > 16) {
        throw std::runtime_error("comm exceeds bounded 16-byte limit");
    }
    if (ev.seq == 0) {
        throw std::runtime_error("event seq must be >= 1");
    }
    if (ev.pid == 0 && ev.tgid == 0) {
        throw std::runtime_error("event pid/tgid cannot both be 0");
    }
    return ev;
}

JsonValue process_node_to_json(const ProcessNode& node) {
    JsonObject obj;
    obj["pid"] = static_cast<uint64_t>(node.pid);
    obj["tgid"] = static_cast<uint64_t>(node.tgid);
    obj["ppid"] = static_cast<uint64_t>(node.ppid);
    obj["comm"] = node.comm;
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

        // Trim whitespace
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
    uint32_t root_pid)
{
    ReconstructionResult res;
    res.root_pid = root_pid;

    for (const auto& ev : raw_events) {
        if (ev.cgroup_id != target_cgroup_id) {
            ++res.excluded_unrelated_cgroup_events;
            continue;
        }
        res.events.push_back(ev);
    }

    std::sort(res.events.begin(), res.events.end(), [](const ObservedEvent& a, const ObservedEvent& b) {
        if (a.seq != b.seq) return a.seq < b.seq;
        return a.timestamp_ns < b.timestamp_ns;
    });

    std::map<uint32_t, ProcessNode> nodes;
    std::map<uint32_t, std::vector<uint32_t>> children_by_parent;
    std::set<uint32_t> known_pids;

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

    uint64_t prev_seq = 0;
    for (const auto& ev : res.events) {
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
                ++res.counts.fork;
                uint32_t child_key = ev.child_tgid != 0 ? ev.child_tgid : ev.child_pid;
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
                    if (!is_external_root_fork) {
                        auto& vec = children_by_parent[key];
                        if (std::find(vec.begin(), vec.end(), child_key) == vec.end()) {
                            vec.push_back(child_key);
                        }
                    }
                }
                break;
            }
            case EventType::Exec: {
                ++res.counts.exec;
                ProcessNode& proc = ensure_node(key, ev.pid);
                if (proc.ppid == 0 && ev.ppid != 0) proc.ppid = ev.ppid;
                proc.comm = ev.comm;
                proc.uid = ev.uid;
                proc.gid = ev.gid;
                if (proc.execed_at_ns == 0) proc.execed_at_ns = ev.timestamp_ns;
                if (ev.ppid != 0 && known_pids.count(ev.ppid)) {
                    auto& vec = children_by_parent[ev.ppid];
                    if (std::find(vec.begin(), vec.end(), key) == vec.end()) {
                        vec.push_back(key);
                    }
                }
                break;
            }
            case EventType::Exit: {
                ++res.counts.exit;
                ProcessNode& proc = ensure_node(key, ev.pid);
                if (proc.ppid == 0 && ev.ppid != 0) proc.ppid = ev.ppid;
                if (proc.comm.empty() && !ev.comm.empty()) proc.comm = ev.comm;
                proc.uid = ev.uid;
                proc.gid = ev.gid;
                proc.exited_at_ns = ev.timestamp_ns;
                proc.exit_code = ev.exit_code;
                break;
            }
        }
    }

    if (res.sequence_gaps > 0) {
        res.anomalies.push_back("sequence_gap_detected");
    }

    // Build tree recursively with cycle guard
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

    // Any remaining disconnected nodes (e.g. cycle) become roots so nothing is silently dropped
    for (const auto& [pid_key, node] : nodes) {
        if (!visited.count(pid_key)) {
            res.process_tree.push_back(build_subtree(build_subtree, pid_key));
        }
    }

    if (res.root_pid == 0 && !res.process_tree.empty()) {
        res.root_pid = res.process_tree[0].tgid;
    }

    return res;
}

} // namespace jc::witness
