#include "witness/canonical_json.hpp"
#include "witness/cgroup.hpp"
#include "witness/crypto.hpp"
#include "witness/observer.hpp"
#include "witness/process_tree.hpp"
#include "witness/receipt.hpp"

#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

using namespace jc::witness;

namespace {

volatile sig_atomic_t g_interrupted = 0;

void handle_signal(int /*sig*/) {
    g_interrupted = 1;
}

std::string read_text_file(const std::string& path) {
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) throw std::runtime_error("failed to open file: " + path);
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

void write_text_file(const std::string& path, const std::string& content) {
    std::ofstream ofs(path, std::ios::binary | std::ios::trunc);
    if (!ofs) throw std::runtime_error("failed to write file: " + path);
    ofs << content;
}

std::string default_observer_id() {
    char host[256]{};
    if (gethostname(host, sizeof(host) - 1) == 0 && host[0] != '\0') {
        return std::string("jc-kernel-witness@") + host;
    }
    return "jc-kernel-witness@localhost";
}

std::string default_bpf_obj_path(const char* argv0) {
    std::string exe(argv0 ? argv0 : "");
    auto slash = exe.rfind('/');
    if (slash != std::string::npos) {
        return exe.substr(0, slash + 1) + "witness.bpf.o";
    }
    return "witness.bpf.o";
}

void print_usage() {
    std::cerr <<
        "Usage:\n"
        "  jc-kernel-witness run [options] -- <cmd> [args...]\n"
        "  jc-kernel-witness replay --events-in <jsonl> --receipt-out <path> [options]\n"
        "  jc-kernel-witness verify --receipt <path> --public-key <pem> [options]\n"
        "  jc-kernel-witness check-bpf [--bpf-obj <path>]\n"
        "  jc-kernel-witness keygen --private-out <path> --public-out <path>\n";
}

int cmd_keygen(int argc, char** argv) {
    std::string priv_out, pub_out;
    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--private-out" && i + 1 < argc) priv_out = argv[++i];
        else if (arg == "--public-out" && i + 1 < argc) pub_out = argv[++i];
        else {
            std::cerr << "Unknown or incomplete option: " << arg << "\n";
            return 2;
        }
    }
    if (priv_out.empty() || pub_out.empty()) {
        std::cerr << "keygen requires --private-out and --public-out\n";
        return 2;
    }
    generate_ed25519_keypair_pem(priv_out, pub_out);
    std::string key_id = derive_key_id_from_public_pem(pub_out, true);
    JsonObject out;
    out["keyId"] = key_id;
    out["privateKeyPath"] = priv_out;
    out["publicKeyPath"] = pub_out;
    std::cout << serialize_canonical_json(JsonValue(std::move(out))) << "\n";
    return 0;
}

int cmd_check_bpf(int argc, char** argv) {
    std::string bpf_obj = default_bpf_obj_path(argv[0]);
    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--bpf-obj" && i + 1 < argc) bpf_obj = argv[++i];
        else {
            std::cerr << "Unknown or incomplete option: " << arg << "\n";
            return 2;
        }
    }
    BpfCheckResult res = check_bpf_object(bpf_obj);
    JsonObject out;
    out["valid"] = res.valid;
    out["bpfObjPath"] = bpf_obj;
    JsonArray progs, maps;
    for (const auto& p : res.programs) progs.emplace_back(p);
    for (const auto& m : res.maps) maps.emplace_back(m);
    out["programs"] = JsonValue(std::move(progs));
    out["maps"] = JsonValue(std::move(maps));
    if (!res.error.empty()) out["error"] = res.error;
    std::cout << serialize_canonical_json(JsonValue(std::move(out))) << "\n";
    return res.valid ? 0 : 1;
}

int cmd_verify(int argc, char** argv) {
    std::string receipt_path, pub_key_path;
    VerificationOptions opts;
    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--receipt" && i + 1 < argc) receipt_path = argv[++i];
        else if (arg == "--public-key" && i + 1 < argc) pub_key_path = argv[++i];
        else if (arg == "--work-item-id" && i + 1 < argc) opts.work_item_id = argv[++i];
        else if (arg == "--attempt-id" && i + 1 < argc) opts.attempt_id = argv[++i];
        else if (arg == "--lease-id" && i + 1 < argc) opts.lease_id = argv[++i];
        else if (arg == "--invocation-hash" && i + 1 < argc) opts.invocation_hash = argv[++i];
        else if (arg == "--previous-evidence-hash" && i + 1 < argc) opts.previous_evidence_hash = argv[++i];
        else if (arg == "--seen-hashes-file" && i + 1 < argc) opts.seen_hashes_file = argv[++i];
        else if (arg == "--require-live") opts.require_live = true;
        else {
            std::cerr << "Unknown or incomplete option: " << arg << "\n";
            return 2;
        }
    }
    if (receipt_path.empty() || pub_key_path.empty()) {
        std::cerr << "verify requires --receipt and --public-key\n";
        return 2;
    }

    VerificationResult res;
    try {
        JsonValue v = parse_json(read_text_file(receipt_path));
        res = verify_receipt(v, pub_key_path, opts, true);
    } catch (const std::exception& ex) {
        res.valid = false;
        res.reasons.push_back(std::string("verify_exception:") + ex.what());
    }

    JsonObject out;
    out["valid"] = res.valid;
    out["evidenceHash"] = res.evidence_hash;
    JsonArray reasons;
    for (const auto& r : res.reasons) reasons.emplace_back(r);
    out["reasons"] = JsonValue(std::move(reasons));
    std::cout << serialize_canonical_json(JsonValue(std::move(out))) << "\n";
    return res.valid ? 0 : 1;
}

int cmd_replay(int argc, char** argv) {
    std::string events_in, receipt_out, signing_key, signing_key_id;
    std::string work_item_id, attempt_id, lease_id, invocation_hash;
    std::string observer_id = default_observer_id();
    std::string cgroup_path = "/sys/fs/cgroup/synthetic";
    uint64_t cgroup_id = 1;
    uint64_t dropped_events = 0;
    std::optional<std::string> prev_hash, anchor_ref;
    bool ephemeral_key = false;

    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--events-in" && i + 1 < argc) events_in = argv[++i];
        else if (arg == "--receipt-out" && i + 1 < argc) receipt_out = argv[++i];
        else if (arg == "--signing-key" && i + 1 < argc) signing_key = argv[++i];
        else if (arg == "--signing-key-id" && i + 1 < argc) signing_key_id = argv[++i];
        else if (arg == "--ephemeral-key") ephemeral_key = true;
        else if (arg == "--work-item-id" && i + 1 < argc) work_item_id = argv[++i];
        else if (arg == "--attempt-id" && i + 1 < argc) attempt_id = argv[++i];
        else if (arg == "--lease-id" && i + 1 < argc) lease_id = argv[++i];
        else if (arg == "--invocation-hash" && i + 1 < argc) invocation_hash = argv[++i];
        else if (arg == "--observer-id" && i + 1 < argc) observer_id = argv[++i];
        else if (arg == "--cgroup-id" && i + 1 < argc) cgroup_id = std::stoull(argv[++i]);
        else if (arg == "--cgroup-path" && i + 1 < argc) cgroup_path = argv[++i];
        else if (arg == "--dropped-events" && i + 1 < argc) dropped_events = std::stoull(argv[++i]);
        else if (arg == "--previous-evidence-hash" && i + 1 < argc) prev_hash = argv[++i];
        else if (arg == "--acs-anchor-ref" && i + 1 < argc) anchor_ref = argv[++i];
        else {
            std::cerr << "Unknown or incomplete option: " << arg << "\n";
            return 2;
        }
    }

    if (events_in.empty() || receipt_out.empty()) {
        std::cerr << "replay requires --events-in and --receipt-out\n";
        return 2;
    }

    bool key_is_path = true;
    if (signing_key.empty()) {
        if (const char* env_key = std::getenv("JC_WITNESS_SIGNING_KEY"); env_key && *env_key) {
            signing_key = env_key;
        } else if (ephemeral_key) {
            signing_key = generate_ephemeral_ed25519_keypair_pem().first;
            key_is_path = false;
        } else {
            std::cerr << "replay requires --signing-key, JC_WITNESS_SIGNING_KEY, or --ephemeral-key\n";
            return 2;
        }
    }

    std::vector<std::string> parse_errors;
    auto raw_events = parse_events_jsonl(read_text_file(events_in), parse_errors);
    auto recon = reconstruct_process_tree(raw_events, cgroup_id);

    ObservationReceipt receipt;
    receipt.observer_mode = "replay";
    receipt.observer_id = observer_id;
    receipt.work_item_id = work_item_id;
    receipt.attempt_id = attempt_id;
    receipt.lease_id = lease_id;
    receipt.invocation_hash = invocation_hash;
    receipt.cgroup_id = cgroup_id;
    receipt.cgroup_path = cgroup_path;
    receipt.start_time_ns = recon.start_time_ns;
    receipt.end_time_ns = recon.end_time_ns;
    receipt.events = std::move(recon.events);
    receipt.process_tree = std::move(recon.process_tree);
    receipt.event_counts = recon.counts;
    receipt.dropped_events = dropped_events;
    receipt.sequence_gaps = recon.sequence_gaps;
    receipt.previous_evidence_hash = prev_hash;
    receipt.acs_anchor_ref = anchor_ref;
    receipt.signing_key_id = signing_key_id;

    for (const auto& e : parse_errors) receipt.incomplete_reasons.push_back(e);
    for (const auto& a : recon.anomalies) receipt.incomplete_reasons.push_back(a);
    if (dropped_events > 0) receipt.incomplete_reasons.push_back("ringbuf_overflow_dropped_events");

    receipt.status = receipt.incomplete_reasons.empty() ? "complete" : "incomplete";
    finalize_and_sign_receipt(receipt, signing_key, key_is_path);
    write_text_file(receipt_out, serialize_canonical_json(receipt_to_json(receipt)) + "\n");
    return 0;
}

int cmd_run(int argc, char** argv) {
    std::string mode = "live";
    if (const char* env_mode = std::getenv("JC_WITNESS_MODE"); env_mode && *env_mode) {
        mode = env_mode;
    }
    std::string receipt_out, signing_key, signing_key_id, cgroup_root, events_in;
    std::string bpf_obj = default_bpf_obj_path(argv[0]);
    std::string work_item_id, attempt_id, lease_id, invocation_hash;
    std::string observer_id = default_observer_id();
    std::optional<std::string> prev_hash, anchor_ref;
    bool ephemeral_key = false;

    int cmd_idx = -1;
    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--") {
            cmd_idx = i + 1;
            break;
        }
        if (arg == "--mode" && i + 1 < argc) mode = argv[++i];
        else if (arg == "--receipt-out" && i + 1 < argc) receipt_out = argv[++i];
        else if (arg == "--signing-key" && i + 1 < argc) signing_key = argv[++i];
        else if (arg == "--signing-key-id" && i + 1 < argc) signing_key_id = argv[++i];
        else if (arg == "--ephemeral-key") ephemeral_key = true;
        else if (arg == "--cgroup-root" && i + 1 < argc) cgroup_root = argv[++i];
        else if (arg == "--bpf-obj" && i + 1 < argc) bpf_obj = argv[++i];
        else if (arg == "--events-in" && i + 1 < argc) events_in = argv[++i];
        else if (arg == "--work-item-id" && i + 1 < argc) work_item_id = argv[++i];
        else if (arg == "--attempt-id" && i + 1 < argc) attempt_id = argv[++i];
        else if (arg == "--lease-id" && i + 1 < argc) lease_id = argv[++i];
        else if (arg == "--invocation-hash" && i + 1 < argc) invocation_hash = argv[++i];
        else if (arg == "--observer-id" && i + 1 < argc) observer_id = argv[++i];
        else if (arg == "--previous-evidence-hash" && i + 1 < argc) prev_hash = argv[++i];
        else if (arg == "--acs-anchor-ref" && i + 1 < argc) anchor_ref = argv[++i];
        else {
            std::cerr << "Unknown or incomplete option: " << arg << "\n";
            return 2;
        }
    }

    if (cmd_idx < 0 || cmd_idx >= argc) {
        std::cerr << "run requires `-- <cmd> [args...]`\n";
        return 2;
    }
    if (mode != "live" && mode != "auto" && mode != "synthetic") {
        std::cerr << "invalid --mode: " << mode << " (expected live|auto|synthetic)\n";
        return 2;
    }

    bool key_is_path = true;
    if (signing_key.empty()) {
        if (const char* env_key = std::getenv("JC_WITNESS_SIGNING_KEY"); env_key && *env_key) {
            signing_key = env_key;
        } else if (ephemeral_key) {
            signing_key = generate_ephemeral_ed25519_keypair_pem().first;
            key_is_path = false;
        } else {
            std::cerr << "run requires --signing-key, JC_WITNESS_SIGNING_KEY, or --ephemeral-key\n";
            return 2;
        }
    }

    // Phase 1: Pre-exec cgroup v2 isolation (fail closed if it cannot be established)
    CgroupLeaf leaf;
    try {
        std::string root = detect_delegated_cgroup_root(cgroup_root);
        leaf = create_witness_cgroup_leaf(root);
    } catch (const std::exception& ex) {
        std::cerr << "jc-kernel-witness fail-closed (cgroup isolation): " << ex.what() << "\n";
        return 70;
    }

    ObservationReceipt receipt;
    receipt.observer_mode = mode;
    receipt.observer_id = observer_id;
    receipt.work_item_id = work_item_id;
    receipt.attempt_id = attempt_id;
    receipt.lease_id = lease_id;
    receipt.invocation_hash = invocation_hash;
    receipt.cgroup_id = leaf.cgroup_id;
    receipt.cgroup_path = leaf.path;
    receipt.previous_evidence_hash = prev_hash;
    receipt.acs_anchor_ref = anchor_ref;
    receipt.signing_key_id = signing_key_id;

    // Phase 2: Initialize eBPF observer BEFORE clone3 if live/auto
    std::unique_ptr<LiveBpfObserver> live_obs;
    bool ebpf_active = false;
    if (mode == "live" || mode == "auto") {
        live_obs = std::make_unique<LiveBpfObserver>(LiveObserverConfig{
            .bpf_obj_path = bpf_obj,
            .cgroup_id = leaf.cgroup_id,
            .invocation_tag = 1,
        });
        std::string obs_err;
        if (live_obs->start(obs_err)) {
            ebpf_active = true;
            receipt.observer_mode = "live";
        } else {
            live_obs.reset();
            if (mode == "live") {
                cleanup_witness_cgroup_leaf(leaf);
                receipt.status = "failed";
                receipt.incomplete_reasons.push_back("unsupported_kernel_or_missing_permissions: " + obs_err);
                if (!receipt_out.empty()) {
                    finalize_and_sign_receipt(receipt, signing_key, key_is_path);
                    write_text_file(receipt_out, serialize_canonical_json(receipt_to_json(receipt)) + "\n");
                }
                std::cerr << "jc-kernel-witness fail-closed (live eBPF): " << obs_err << "\n";
                return 71;
            }
            receipt.observer_mode = "auto-unprivileged";
            receipt.incomplete_reasons.push_back("ebpf_unavailable_missing_permissions");
        }
    }

    std::signal(SIGINT, handle_signal);
    std::signal(SIGTERM, handle_signal);

    // Launch target command directly into the cgroup v2 leaf via clone3(CLONE_INTO_CGROUP)
    std::vector<char*> child_argv;
    for (int i = cmd_idx; i < argc; ++i) {
        child_argv.push_back(argv[i]);
    }
    child_argv.push_back(nullptr);

    pid_t child_pid = -1;
    try {
        child_pid = clone_into_cgroup(leaf.dir_fd, [&]() -> int {
            execvp(child_argv[0], child_argv.data());
            return 127;
        });
    } catch (const std::exception& ex) {
        if (ebpf_active && live_obs) {
            uint64_t ignored_drops = 0;
            live_obs->stop_and_drain(ignored_drops);
        }
        cleanup_witness_cgroup_leaf(leaf);
        std::cerr << "jc-kernel-witness fail-closed (clone3): " << ex.what() << "\n";
        return 72;
    }

    int wstatus = 0;
    int child_exit_code = 1;
    while (true) {
        if (ebpf_active && live_obs) {
            live_obs->poll(20);
        }
        pid_t w = waitpid(child_pid, &wstatus, ebpf_active ? WNOHANG : 0);
        if (w == child_pid) {
            if (WIFEXITED(wstatus)) child_exit_code = WEXITSTATUS(wstatus);
            else if (WIFSIGNALED(wstatus)) child_exit_code = 128 + WTERMSIG(wstatus);
            break;
        }
        if (w < 0 && errno != EINTR) {
            receipt.incomplete_reasons.push_back("waitpid_error");
            break;
        }
        if (g_interrupted) {
            receipt.incomplete_reasons.push_back("observer_interrupted");
            kill(child_pid, SIGKILL);
            waitpid(child_pid, &wstatus, 0);
            child_exit_code = 130;
            break;
        }
    }

    std::vector<ObservedEvent> raw_events;
    uint64_t dropped_events = 0;
    if (ebpf_active && live_obs) {
        live_obs->stop_and_drain(dropped_events);
        raw_events = live_obs->events();
        if (live_obs->ringbuf_error()) {
            receipt.incomplete_reasons.push_back("ringbuf_poll_error");
        }
        if (dropped_events > 0) {
            receipt.incomplete_reasons.push_back("ringbuf_overflow_dropped_events");
        }
    } else if (mode == "synthetic" && !events_in.empty()) {
        std::vector<std::string> parse_errors;
        raw_events = parse_events_jsonl(read_text_file(events_in), parse_errors);
        for (const auto& e : parse_errors) receipt.incomplete_reasons.push_back(e);
    }

    // Clean up ONLY the cgroup leaf created by the witness AFTER processes exit
    if (!cleanup_witness_cgroup_leaf(leaf)) {
        receipt.incomplete_reasons.push_back("cgroup_cleanup_failed");
    }

    auto recon = reconstruct_process_tree(raw_events, leaf.cgroup_id);
    receipt.start_time_ns = recon.start_time_ns;
    receipt.end_time_ns = recon.end_time_ns;
    receipt.events = std::move(recon.events);
    receipt.process_tree = std::move(recon.process_tree);
    receipt.event_counts = recon.counts;
    receipt.dropped_events = dropped_events;
    receipt.sequence_gaps = recon.sequence_gaps;
    for (const auto& a : recon.anomalies) {
        receipt.incomplete_reasons.push_back(a);
    }

    receipt.status = receipt.incomplete_reasons.empty() ? "complete" : "incomplete";
    finalize_and_sign_receipt(receipt, signing_key, key_is_path);

    if (!receipt_out.empty()) {
        write_text_file(receipt_out, serialize_canonical_json(receipt_to_json(receipt)) + "\n");
    }
    return child_exit_code;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        print_usage();
        return 2;
    }
    std::string sub = argv[1];
    try {
        if (sub == "keygen") return cmd_keygen(argc, argv);
        if (sub == "check-bpf") return cmd_check_bpf(argc, argv);
        if (sub == "verify") return cmd_verify(argc, argv);
        if (sub == "replay") return cmd_replay(argc, argv);
        if (sub == "run") return cmd_run(argc, argv);
        print_usage();
        return 2;
    } catch (const std::exception& ex) {
        std::cerr << "jc-kernel-witness error: " << ex.what() << "\n";
        return 1;
    }
}
