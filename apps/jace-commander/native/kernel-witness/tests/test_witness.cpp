#include "witness/canonical_json.hpp"
#include "witness/cgroup.hpp"
#include "witness/crypto.hpp"
#include "witness/observer.hpp"
#include "witness/process_tree.hpp"
#include "witness/receipt.hpp"
#include "witness/signer.hpp"
#include "witness_event.h"

#include <arpa/inet.h>
#include <cassert>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

using namespace jc::witness;

namespace {

int g_tests_run = 0;

#define RUN_TEST(fn) do { \
    std::cout << "[TEST] " << #fn << "... "; \
    fn(); \
    ++g_tests_run; \
    std::cout << "PASS\n"; \
} while (0)

ObservedEvent make_ev(
    uint64_t seq, uint64_t ts, uint64_t cg, EventType type,
    uint32_t pid, uint32_t ppid, uint32_t child_pid, int32_t exit_code, const std::string& comm)
{
    ObservedEvent ev;
    ev.seq = seq;
    ev.timestamp_ns = ts;
    ev.cgroup_id = cg;
    ev.event_type = type;
    ev.pid = pid;
    ev.tgid = pid;
    ev.ppid = ppid;
    ev.child_pid = child_pid;
    ev.child_tgid = child_pid;
    ev.uid = 1000;
    ev.gid = 1000;
    ev.exit_code = exit_code;
    ev.comm = comm;
    return ev;
}

void test_canonical_json_and_ed25519() {
    JsonObject obj;
    obj["z"] = 1;
    obj["a"] = "hello";
    obj["m"] = true;
    std::string c = serialize_canonical_json(JsonValue(obj));
    assert(c == R"({"a":"hello","m":true,"z":1})");

    auto [priv1, pub1] = generate_ephemeral_ed25519_keypair_pem();
    auto [priv2, pub2] = generate_ephemeral_ed25519_keypair_pem();

    std::string sig = ed25519_sign_pem(c, priv1, false);
    assert(ed25519_verify_pem(c, sig, pub1, false));
    assert(!ed25519_verify_pem(c, sig, pub2, false));
    assert(!ed25519_verify_pem(c + " ", sig, pub1, false));
}

void test_process_tree_3_subprocesses_and_cgroup_filter() {
    const uint64_t target_cg = 4242;
    const uint64_t foreign_cg = 9999;

    std::vector<ObservedEvent> raw = {
        make_ev(1, 1000, target_cg, EventType::Exec, 100, 1, 0, 0, "sh"),
        make_ev(2, 1050, foreign_cg, EventType::Exec, 888, 1, 0, 0, "evil"),
        make_ev(2, 1100, target_cg, EventType::Fork, 100, 1, 101, 0, "sh"),
        make_ev(3, 1200, target_cg, EventType::Exec, 101, 100, 0, 0, "python3"),
        make_ev(4, 1300, target_cg, EventType::Fork, 101, 100, 102, 0, "python3"),
        make_ev(5, 1400, target_cg, EventType::Exec, 102, 101, 0, 0, "ls"),
        make_ev(6, 1500, target_cg, EventType::Exit, 102, 101, 0, 0, "ls"),
        make_ev(7, 1600, target_cg, EventType::Exit, 101, 100, 0, 0, "python3"),
        make_ev(8, 1700, target_cg, EventType::Fork, 100, 1, 103, 0, "sh"),
        make_ev(9, 1800, target_cg, EventType::Exec, 103, 100, 0, 0, "echo"),
        make_ev(10, 1900, target_cg, EventType::Exit, 103, 100, 0, 0, "echo"),
        make_ev(11, 2000, target_cg, EventType::Exit, 100, 1, 0, 0, "sh"),
    };

    auto recon = reconstruct_process_tree(raw, target_cg);
    assert(recon.excluded_unrelated_cgroup_events == 1);
    assert(recon.sequence_gaps == 0);
    assert(recon.anomalies.empty());
    assert(recon.counts.total == 11);
    assert(recon.counts.fork == 3);
    assert(recon.counts.exec == 4);
    assert(recon.counts.exit == 4);
    assert(recon.process_tree.size() == 1);

    const auto& root = recon.process_tree[0];
    assert(root.tgid == 100);
    assert(root.comm == "sh");
    assert(root.children.size() == 2);
    assert(root.children[0].tgid == 101);
    assert(root.children[0].comm == "python3");
    assert(root.children[0].children.size() == 1);
    assert(root.children[0].children[0].tgid == 102);
    assert(root.children[0].children[0].comm == "ls");
    assert(root.children[1].tgid == 103);
    assert(root.children[1].comm == "echo");
}

void test_sequence_gap_and_ringbuf_overflow_rejected() {
    auto [priv, pub] = generate_ephemeral_ed25519_keypair_pem();
    const uint64_t cg = 100;

    std::vector<ObservedEvent> raw = {
        make_ev(1, 1000, cg, EventType::Exec, 100, 1, 0, 0, "sh"),
        make_ev(3, 1200, cg, EventType::Exit, 100, 1, 0, 0, "sh"),
    };
    auto recon = reconstruct_process_tree(raw, cg);
    assert(recon.sequence_gaps == 1);

    ObservationReceipt r;
    r.observer_mode = "live";
    r.observer_id = "test-obs";
    r.work_item_id = "wi-1";
    r.attempt_id = "att-1";
    r.lease_id = "lease-1";
    r.invocation_hash = "inv-1";
    r.cgroup_id = cg;
    r.cgroup_path = "/sys/fs/cgroup/test";
    r.events = recon.events;
    r.process_tree = recon.process_tree;
    r.category_completeness = recon.category_completeness;
    r.event_counts = recon.counts;
    r.sequence_gaps = recon.sequence_gaps;
    r.dropped_events = 2;
    r.incomplete_reasons = {"ringbuf_overflow_dropped_events", "sequence_gap_detected"};
    r.status = "incomplete";
    finalize_and_sign_receipt(r, priv, false);

    VerificationOptions opts;
    opts.work_item_id = "wi-1";
    opts.attempt_id = "att-1";
    opts.lease_id = "lease-1";
    opts.invocation_hash = "inv-1";

    auto vr = verify_receipt(receipt_to_json(r), pub, opts, false);
    assert(!vr.valid);
    assert(!vr.reasons.empty());

    JsonValue j = receipt_to_json(r);
    j.as_object_mut()["status"] = "complete";
    j.as_object_mut()["incompleteReasons"] = JsonArray{};
    auto vr_tampered = verify_receipt(j, pub, opts, false);
    assert(!vr_tampered.valid);
}

void test_malformed_event_handling() {
    std::string bad_jsonl =
        "{\"seq\":1,\"timestampNs\":100,\"cgroupId\":1,\"eventType\":\"EXEC\",\"pid\":10,\"tgid\":10,\"ppid\":1,\"childPid\":0,\"childTgid\":0,\"uid\":0,\"gid\":0,\"exitCode\":0,\"comm\":\"ok\"}\n"
        "not-json\n"
        "{\"seq\":0,\"timestampNs\":100,\"cgroupId\":1,\"eventType\":\"EXEC\",\"pid\":10,\"tgid\":10,\"ppid\":1,\"childPid\":0,\"childTgid\":0,\"uid\":0,\"gid\":0,\"exitCode\":0,\"comm\":\"zero-seq\"}\n"
        "{\"seq\":2,\"timestampNs\":100,\"cgroupId\":1,\"eventType\":\"EXEC\",\"pid\":10,\"tgid\":10,\"ppid\":1,\"childPid\":0,\"childTgid\":0,\"uid\":0,\"gid\":0,\"exitCode\":0,\"comm\":\"this-comm-is-way-too-long\"}\n";

    std::vector<std::string> errors;
    auto events = parse_events_jsonl(bad_jsonl, errors);
    assert(events.size() == 1);
    assert(errors.size() == 3);
}

void test_hash_chain_tamper_replay_and_correlation() {
    auto [priv, pub] = generate_ephemeral_ed25519_keypair_pem();
    const uint64_t cg = 555;

    std::vector<ObservedEvent> raw = {
        make_ev(1, 1000, cg, EventType::Exec, 200, 1, 0, 0, "echo"),
        make_ev(2, 1100, cg, EventType::Exit, 200, 1, 0, 0, "echo"),
    };
    auto recon = reconstruct_process_tree(raw, cg);

    ObservationReceipt r1;
    r1.observer_mode = "live";
    r1.observer_id = "obs-1";
    r1.work_item_id = "wi-1";
    r1.attempt_id = "att-1";
    r1.lease_id = "lease-1";
    r1.invocation_hash = "inv-1";
    r1.cgroup_id = cg;
    r1.cgroup_path = "/sys/fs/cgroup/leaf1";
    r1.start_time_ns = recon.start_time_ns;
    r1.end_time_ns = recon.end_time_ns;
    r1.events = recon.events;
    r1.process_tree = recon.process_tree;
    r1.category_completeness = recon.category_completeness;
    r1.event_counts = recon.counts;
    r1.status = "complete";
    finalize_and_sign_receipt(r1, priv, false);

    ObservationReceipt r2 = r1;
    r2.previous_evidence_hash = r1.evidence_hash;
    r2.invocation_hash = "inv-2";
    finalize_and_sign_receipt(r2, priv, false);

    std::string seen_file = "/tmp/jc_witness_test_seen_" + std::to_string(getpid()) + ".txt";
    std::filesystem::remove(seen_file);

    VerificationOptions opts;
    opts.work_item_id = "wi-1";
    opts.attempt_id = "att-1";
    opts.lease_id = "lease-1";
    opts.invocation_hash = "inv-2";
    opts.previous_evidence_hash = r1.evidence_hash;
    opts.seen_hashes_file = seen_file;
    opts.require_live = true;

    JsonValue j2 = receipt_to_json(r2);
    auto v_ok = verify_receipt(j2, pub, opts, false);
    assert(v_ok.valid);

    auto v_replay = verify_receipt(j2, pub, opts, false);
    assert(!v_replay.valid);

    opts.seen_hashes_file.clear();
    JsonValue j2_tampered = j2;
    j2_tampered.as_object_mut()["cgroupId"] = static_cast<uint64_t>(777);
    auto v_tamper = verify_receipt(j2_tampered, pub, opts, false);
    assert(!v_tamper.valid);

    opts.lease_id = "wrong-lease";
    auto v_corr = verify_receipt(j2, pub, opts, false);
    assert(!v_corr.valid);

    std::filesystem::remove(seen_file);
}

void test_bpf_object_open_and_btf_check() {
    const char* bpf_path = std::getenv("JC_WITNESS_TEST_BPF_OBJ");
    std::string path = (bpf_path && *bpf_path) ? bpf_path : "./witness.bpf.o";
    BpfCheckResult res = check_bpf_object(path);
    assert(res.valid);
    assert(res.programs.size() >= 23);
    assert(res.maps.size() >= 7);
}

void test_pre_exec_cgroup_v2_lifecycle() {
    std::string root;
    try {
        root = detect_delegated_cgroup_root();
    } catch (const std::exception& ex) {
        std::cout << "(skipped: no delegated cgroup v2 root: " << ex.what() << ") ";
        return;
    }

    CgroupLeaf leaf = create_witness_cgroup_leaf(root, "jc-witness-test");
    assert(leaf.cgroup_id != 0);
    assert(std::filesystem::exists(leaf.path));

    int pipefd[2]{};
    assert(pipe(pipefd) == 0);

    pid_t pid = clone_into_cgroup(leaf.dir_fd, [&]() -> int {
        close(pipefd[0]);
        std::ifstream ifs("/proc/self/cgroup");
        std::string content((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
        ssize_t n = write(pipefd[1], content.data(), content.size());
        (void)n;
        close(pipefd[1]);
        return 0;
    });
    close(pipefd[1]);

    std::string child_cg;
    char buf[512];
    ssize_t n = 0;
    while ((n = read(pipefd[0], buf, sizeof(buf))) > 0) {
        child_cg.append(buf, static_cast<size_t>(n));
    }
    close(pipefd[0]);

    int wstatus = 0;
    assert(waitpid(pid, &wstatus, 0) == pid);
    assert(WIFEXITED(wstatus) && WEXITSTATUS(wstatus) == 0);

    std::string leaf_name = std::filesystem::path(leaf.path).filename().string();
    assert(child_cg.find(leaf_name) != std::string::npos);

    assert(cleanup_witness_cgroup_leaf(leaf));
    assert(!std::filesystem::exists(leaf.path));
}

void test_root_fork_exec_3_subprocesses_and_root_pid_verification() {
    auto [priv, pub] = generate_ephemeral_ed25519_keypair_pem();
    const uint64_t target_cg = 8888;
    const uint32_t external_witness_pid = 50;
    const uint32_t root_pid = 100;

    std::vector<ObservedEvent> raw = {
        make_ev(1, 900, target_cg, EventType::Fork, external_witness_pid, 1, root_pid, 0, "jc-kernel-witne"),
        make_ev(2, 1000, target_cg, EventType::Exec, root_pid, external_witness_pid, 0, 0, "sh"),
        make_ev(3, 1100, target_cg, EventType::Fork, root_pid, external_witness_pid, 101, 0, "sh"),
        make_ev(4, 1200, target_cg, EventType::Exec, 101, root_pid, 0, 0, "python3"),
        make_ev(5, 1300, target_cg, EventType::Fork, 101, root_pid, 102, 0, "python3"),
        make_ev(6, 1400, target_cg, EventType::Exec, 102, 101, 0, 0, "ls"),
        make_ev(7, 1500, target_cg, EventType::Exit, 102, 101, 0, 0, "ls"),
        make_ev(8, 1600, target_cg, EventType::Exit, 101, root_pid, 0, 0, "python3"),
        make_ev(9, 1700, target_cg, EventType::Fork, root_pid, external_witness_pid, 103, 0, "sh"),
        make_ev(10, 1800, target_cg, EventType::Exec, 103, root_pid, 0, 0, "echo"),
        make_ev(11, 1900, target_cg, EventType::Exit, 103, root_pid, 0, 0, "echo"),
        make_ev(12, 2000, target_cg, EventType::Exit, root_pid, external_witness_pid, 0, 0, "sh"),
    };

    auto recon = reconstruct_process_tree(raw, target_cg, root_pid);
    assert(recon.root_pid == root_pid);
    assert(recon.process_tree.size() == 1);
    assert(recon.process_tree[0].tgid == root_pid);
    assert(recon.process_tree[0].ppid == external_witness_pid);
    assert(recon.process_tree[0].forked_at_ns == 900);
    assert(recon.process_tree[0].execed_at_ns == 1000);
    assert(recon.process_tree[0].exited_at_ns == 2000);
    assert(recon.process_tree[0].children.size() == 2);

    ObservationReceipt r;
    r.observer_mode = "live";
    r.observer_id = "test-obs";
    r.work_item_id = "wi-root";
    r.attempt_id = "att-root";
    r.lease_id = "lease-root";
    r.invocation_hash = "inv-root";
    r.cgroup_id = target_cg;
    r.cgroup_path = "/sys/fs/cgroup/root-test";
    r.root_pid = recon.root_pid;
    r.start_time_ns = recon.start_time_ns;
    r.end_time_ns = recon.end_time_ns;
    r.events = recon.events;
    r.process_tree = recon.process_tree;
    r.category_completeness = recon.category_completeness;
    r.event_counts = recon.counts;
    r.status = "complete";
    finalize_and_sign_receipt(r, priv, false);

    VerificationOptions opts;
    opts.expected_root_pid = root_pid;
    auto vr_ok = verify_receipt(receipt_to_json(r), pub, opts, false);
    assert(vr_ok.valid);

    opts.expected_root_pid = 999;
    auto vr_bad = verify_receipt(receipt_to_json(r), pub, opts, false);
    assert(!vr_bad.valid);
}

void test_p0_01_keygen_permissions_0600() {
    std::string priv_path = "/tmp/jc_witness_priv_" + std::to_string(getpid()) + ".pem";
    std::string pub_path = "/tmp/jc_witness_pub_" + std::to_string(getpid()) + ".pem";
    std::filesystem::remove(priv_path);
    std::filesystem::remove(pub_path);

    generate_ed25519_keypair_pem(priv_path, pub_path);

    struct stat st{};
    assert(stat(priv_path.c_str(), &st) == 0);
    assert((st.st_mode & 0777) == 0600);

    std::filesystem::remove(priv_path);
    std::filesystem::remove(pub_path);
}

void test_p1_04_clone_thread_no_self_loop_or_exit_clobber() {
    const uint64_t cg = 7070;
    ObservedEvent exec_leader = make_ev(1, 1000, cg, EventType::Exec, 500, 1, 0, 0, "worker");

    // CLONE_THREAD: child_tgid == tgid (500), child_pid == 501
    ObservedEvent thread_fork = make_ev(2, 1100, cg, EventType::Fork, 500, 1, 501, 0, "worker");
    thread_fork.child_pid = 501;
    thread_fork.child_tgid = 500;

    // Leader exits with exit_code 0
    ObservedEvent leader_exit = make_ev(3, 1200, cg, EventType::Exit, 500, 1, 0, 0, "worker");
    leader_exit.pid = 500;
    leader_exit.tgid = 500;
    leader_exit.exit_code = 0;

    // Worker thread 501 exits later with exit_code 42
    ObservedEvent thread_exit = make_ev(4, 1300, cg, EventType::Exit, 501, 1, 0, 42, "worker");
    thread_exit.pid = 501;
    thread_exit.tgid = 500;
    thread_exit.exit_code = 42;

    auto recon = reconstruct_process_tree({exec_leader, thread_fork, leader_exit, thread_exit}, cg, 500);
    assert(recon.process_tree.size() == 1);
    assert(recon.process_tree[0].tgid == 500);
    assert(recon.process_tree[0].ppid == 1);
    assert(recon.process_tree[0].children.empty());
    assert(recon.process_tree[0].exited_at_ns == 1200);
    assert(recon.process_tree[0].exit_code == 0);
}

void test_p1_05_non_utf8_comm_and_path_sanitization() {
    const uint64_t cg = 8080;
    std::string bad_comm = std::string("bad\xff\xfe") + "name";
    ObservedEvent ev = make_ev(1, 1000, cg, EventType::Exec, 600, 1, 0, 0, bad_comm);

    ObservedEvent fs_ev = make_ev(2, 1100, cg, EventType::Fs, 600, 1, 0, 0, bad_comm);
    fs_ev.op = WITNESS_FS_CREATE;
    fs_ev.phase = WITNESS_PHASE_COMPLETED;
    fs_ev.path = "/tmp/invalid_\xff\xfe_file.txt";

    ReconstructionOptions ropts;
    ropts.include_display_paths = true;
    auto recon = reconstruct_process_tree({ev, fs_ev}, cg, 600, ropts);
    assert(recon.process_tree.size() == 1);
    assert(recon.process_tree[0].comm == "bad??name");
    assert(recon.filesystem_events.size() == 1);
    assert(recon.filesystem_events[0].display_path.value() == "/tmp/invalid_??_file.txt");

    // Must serialize cleanly without throwing on invalid UTF-8
    auto [priv, pub] = generate_ephemeral_ed25519_keypair_pem();
    ObservationReceipt r;
    r.observer_mode = "live";
    r.observer_id = "utf8-test";
    r.work_item_id = "wi-u";
    r.attempt_id = "att-u";
    r.lease_id = "lease-u";
    r.invocation_hash = "inv-u";
    r.cgroup_id = cg;
    r.cgroup_path = "/sys/fs/cgroup/u";
    r.root_pid = 600;
    r.start_time_ns = recon.start_time_ns;
    r.end_time_ns = recon.end_time_ns;
    r.events = recon.events;
    r.process_tree = recon.process_tree;
    r.filesystem_events = recon.filesystem_events;
    r.category_completeness = recon.category_completeness;
    r.event_counts = recon.counts;
    finalize_and_sign_receipt(r, priv, false);
    std::string json_out = serialize_canonical_json(receipt_to_json(r));
    assert(!json_out.empty());
}

void test_p2_01_concurrent_flock_replay_protection() {
    auto [priv, pub] = generate_ephemeral_ed25519_keypair_pem();
    const uint64_t cg = 9090;
    auto recon = reconstruct_process_tree({
        make_ev(1, 1000, cg, EventType::Exec, 700, 1, 0, 0, "sh"),
        make_ev(2, 1100, cg, EventType::Exit, 700, 1, 0, 0, "sh"),
    }, cg, 700);

    ObservationReceipt r;
    r.observer_mode = "live";
    r.observer_id = "obs-flock";
    r.work_item_id = "wi-f";
    r.attempt_id = "att-f";
    r.lease_id = "lease-f";
    r.invocation_hash = "inv-f";
    r.cgroup_id = cg;
    r.cgroup_path = "/sys/fs/cgroup/f";
    r.root_pid = 700;
    r.start_time_ns = recon.start_time_ns;
    r.end_time_ns = recon.end_time_ns;
    r.events = recon.events;
    r.process_tree = recon.process_tree;
    r.category_completeness = recon.category_completeness;
    r.event_counts = recon.counts;
    finalize_and_sign_receipt(r, priv, false);

    JsonValue j = receipt_to_json(r);
    std::string seen_file = "/tmp/jc_witness_flock_" + std::to_string(getpid()) + ".txt";
    std::filesystem::remove(seen_file);

    VerificationOptions opts;
    opts.seen_hashes_file = seen_file;

    std::atomic<int> successes{0};
    std::vector<std::thread> threads;
    for (int i = 0; i < 8; ++i) {
        threads.emplace_back([&]() {
            auto vr = verify_receipt(j, pub, opts, false);
            if (vr.valid) ++successes;
        });
    }
    for (auto& t : threads) t.join();
    assert(successes.load() == 1);
    std::filesystem::remove(seen_file);
}

void test_phase2_signerd_broker_peercred_and_audit_chain() {
    std::string base = "/tmp/jc_signerd_test_" + std::to_string(getpid());
    std::string priv_path = base + "_priv.pem";
    std::string pub_path = base + "_pub.pem";
    std::string manifest_path = base + "_manifest.json";
    std::string sock_path = base + ".sock";
    std::string audit_path = base + "_audit.jsonl";

    std::filesystem::remove(priv_path);
    std::filesystem::remove(pub_path);
    std::filesystem::remove(manifest_path);
    std::filesystem::remove(sock_path);
    std::filesystem::remove(audit_path);

    KeyRecord kr = key_admin_register(manifest_path, priv_path, pub_path);
    assert(kr.state == "active");

    // 1. World-readable private key MUST be rejected by SignerDaemon
    chmod(priv_path.c_str(), 0644);
    bool rejected_open_perms = false;
    try {
        SignerConfig bad_cfg;
        bad_cfg.socket_path = sock_path;
        bad_cfg.private_key_path = priv_path;
        SignerDaemon bad_daemon(bad_cfg);
    } catch (const std::exception&) {
        rejected_open_perms = true;
    }
    assert(rejected_open_perms);
    chmod(priv_path.c_str(), 0600);

    // 2. Start SignerDaemon in background thread
    SignerConfig cfg;
    cfg.socket_path = sock_path;
    cfg.private_key_path = priv_path;
    cfg.key_manifest_path = manifest_path;
    cfg.audit_log_path = audit_path;
    cfg.allowed_uids = {geteuid()};
    cfg.require_distinct_uid = false;
    cfg.allow_synthetic_for_tests = false;

    std::atomic<bool> stop_flag{false};
    SignerDaemon daemon(cfg);
    daemon.start_listening();
    std::thread server_thread([&]() {
        daemon.serve_forever(stop_flag);
    });

    const uint64_t cg = 1111;
    auto recon = reconstruct_process_tree({
        make_ev(1, 1000, cg, EventType::Exec, 300, 1, 0, 0, "sh"),
        make_ev(2, 1200, cg, EventType::Exit, 300, 1, 0, 0, "sh"),
    }, cg, 300);

    ObservationReceipt r1;
    r1.observer_mode = "live";
    r1.observer_id = "obs-broker";
    r1.work_item_id = "wi-b1";
    r1.attempt_id = "att-b1";
    r1.lease_id = "lease-b1";
    r1.invocation_hash = "inv-b1";
    r1.cgroup_id = cg;
    r1.cgroup_path = "/sys/fs/cgroup/b1";
    r1.root_pid = 300;
    r1.start_time_ns = recon.start_time_ns;
    r1.end_time_ns = recon.end_time_ns;
    r1.events = recon.events;
    r1.process_tree = recon.process_tree;
    r1.category_completeness = recon.category_completeness;
    r1.event_counts = recon.counts;
    r1.status = "complete";

    // 3. Valid live receipt is signed over socket
    sign_receipt_via_socket(r1, sock_path);
    assert(r1.signing_key_id == kr.key_id);
    assert(!r1.evidence_hash.empty());
    assert(!r1.signature.empty());

    VerificationOptions vopts;
    vopts.key_manifest_path = manifest_path;
    vopts.require_live = true;
    vopts.require_v2 = true;
    auto vr1 = verify_receipt(receipt_to_json(r1), pub_path, vopts, true);
    assert(vr1.valid);

    // 4. Synthetic receipt MUST be rejected by SignerDaemon when allow_synthetic_for_tests == false
    ObservationReceipt r_synth = r1;
    r_synth.observer_mode = "synthetic";
    r_synth.previous_evidence_hash = r1.evidence_hash;
    bool synth_rejected = false;
    try {
        sign_receipt_via_socket(r_synth, sock_path);
    } catch (const std::exception& ex) {
        synth_rejected = (std::string(ex.what()).find("observer_mode_not_live_rejected") != std::string::npos);
    }
    assert(synth_rejected);

    // 5. Broken lease hash chain MUST be rejected by SignerDaemon
    ObservationReceipt r_bad_chain = r1;
    r_bad_chain.previous_evidence_hash = "0000000000000000000000000000000000000000000000000000000000000000";
    bool chain_rejected = false;
    try {
        sign_receipt_via_socket(r_bad_chain, sock_path);
    } catch (const std::exception& ex) {
        chain_rejected = (std::string(ex.what()).find("broken_lease_hash_chain") != std::string::npos);
    }
    assert(chain_rejected);

    stop_flag.store(true);
    server_thread.join();
    daemon.stop();

    // 6. Verify require_distinct_uid rejects same-UID peer
    SignerConfig distinct_cfg = cfg;
    distinct_cfg.require_distinct_uid = true;
    std::atomic<bool> stop_flag2{false};
    SignerDaemon distinct_daemon(distinct_cfg);
    distinct_daemon.start_listening();
    std::thread server_thread2([&]() {
        distinct_daemon.serve_forever(stop_flag2);
    });

    ObservationReceipt r_same_uid = r1;
    r_same_uid.lease_id = "lease-b2";
    bool same_uid_rejected = false;
    try {
        sign_receipt_via_socket(r_same_uid, sock_path);
    } catch (const std::exception& ex) {
        same_uid_rejected = (std::string(ex.what()).find("peer_uid_matches_signer_uid_rejected") != std::string::npos);
    }
    assert(same_uid_rejected);

    stop_flag2.store(true);
    server_thread2.join();
    distinct_daemon.stop();

    // 7. Verify tamper-evident hash-chained signer audit log
    std::string audit_err;
    size_t entry_count = 0;
    assert(verify_signer_audit_log(audit_path, audit_err, &entry_count));
    assert(entry_count == 4); // 1 approved + 3 rejected

    std::filesystem::remove(priv_path);
    std::filesystem::remove(pub_path);
    std::filesystem::remove(manifest_path);
    std::filesystem::remove(sock_path);
    std::filesystem::remove(audit_path);
}

void test_phase2_key_lifecycle_register_rotate_retire_revoke() {
    std::string base = "/tmp/jc_keylife_test_" + std::to_string(getpid());
    std::string manifest_path = base + "_manifest.json";
    std::string priv1 = base + "_priv1.pem", pub1 = base + "_pub1.pem";
    std::string priv2 = base + "_priv2.pem", pub2 = base + "_pub2.pem";

    KeyRecord k1 = key_admin_register(manifest_path, priv1, pub1);
    assert(k1.state == "active");

    const uint64_t cg = 2222;
    auto recon = reconstruct_process_tree({
        make_ev(1, 1000, cg, EventType::Exec, 400, 1, 0, 0, "sh"),
        make_ev(2, 1200, cg, EventType::Exit, 400, 1, 0, 0, "sh"),
    }, cg, 400);

    ObservationReceipt r1;
    r1.observer_mode = "live";
    r1.observer_id = "obs-kl";
    r1.work_item_id = "wi-kl";
    r1.attempt_id = "att-kl";
    r1.lease_id = "lease-kl";
    r1.invocation_hash = "inv-kl";
    r1.cgroup_id = cg;
    r1.cgroup_path = "/sys/fs/cgroup/kl";
    r1.root_pid = 400;
    r1.start_time_ns = recon.start_time_ns;
    r1.end_time_ns = recon.end_time_ns;
    r1.events = recon.events;
    r1.process_tree = recon.process_tree;
    r1.category_completeness = recon.category_completeness;
    r1.event_counts = recon.counts;
    r1.signed_at_utc = "2026-11-13T12:00:00.000Z";
    finalize_and_sign_receipt(r1, priv1, true);

    // Rotate k1 -> k2
    KeyRecord k2 = key_admin_rotate(manifest_path, priv2, pub2);
    assert(k2.state == "active");
    KeyManifest m = load_key_manifest(manifest_path);
    assert(m.active_key_id == k2.key_id);
    assert(m.keys.size() == 2);
    assert(m.keys[0].state == "rotated");
    assert(m.keys[0].replaced_by_key_id.value() == k2.key_id);

    // Historical receipt r1 signed by rotated k1 still verifies!
    VerificationOptions vopts;
    vopts.key_manifest_path = manifest_path;
    assert(verify_receipt(receipt_to_json(r1), "", vopts, false).valid);

    // Retire k1 at 2026-11-13T13:00:00.000Z
    key_admin_retire(manifest_path, k1.key_id, "2026-11-13T13:00:00.000Z");
    // r1 was signed at 12:00:00Z (before retirement cutoff) -> still verifies!
    assert(verify_receipt(receipt_to_json(r1), "", vopts, false).valid);

    // Receipt signed by k1 at 14:00:00Z (after retirement cutoff) -> MUST be rejected!
    ObservationReceipt r_late = r1;
    r_late.signed_at_utc = "2026-11-13T14:00:00.000Z";
    finalize_and_sign_receipt(r_late, priv1, true);
    assert(!verify_receipt(receipt_to_json(r_late), "", vopts, false).valid);

    // Revoke k1 -> even historical r1 MUST now be rejected!
    key_admin_revoke(manifest_path, k1.key_id, "key_compromise_simulation");
    auto vr_revoked = verify_receipt(receipt_to_json(r1), "", vopts, false);
    assert(!vr_revoked.valid);

    std::filesystem::remove(manifest_path);
    std::filesystem::remove(priv1);
    std::filesystem::remove(pub1);
    std::filesystem::remove(priv2);
    std::filesystem::remove(pub2);
}

void test_phase4_filesystem_events_hmac_digest_and_completeness() {
    const uint64_t cg = 3333;
    std::vector<ObservedEvent> raw;

    // 1. EXEC root
    raw.push_back(make_ev(1, 1000, cg, EventType::Exec, 500, 1, 0, 0, "python3"));

    // 2. CREATE /workspace/out.txt (attempted + completed)
    ObservedEvent fs_create_att = make_ev(2, 1100, cg, EventType::Fs, 500, 1, 0, 0, "python3");
    fs_create_att.op = WITNESS_FS_CREATE;
    fs_create_att.phase = WITNESS_PHASE_ATTEMPTED;
    fs_create_att.path = "/workspace/out.txt";
    raw.push_back(fs_create_att);

    ObservedEvent fs_create_comp = fs_create_att;
    fs_create_comp.seq = 3;
    fs_create_comp.timestamp_ns = 1150;
    fs_create_comp.phase = WITNESS_PHASE_COMPLETED;
    fs_create_comp.dev = 2049;
    fs_create_comp.inode = 90001;
    fs_create_comp.result_errno = 0;
    raw.push_back(fs_create_comp);

    // 3. MODIFY fd (only dentry basename in raw event, enriched from inode_path_table!)
    ObservedEvent fs_mod_att = make_ev(4, 1200, cg, EventType::Fs, 500, 1, 0, 0, "python3");
    fs_mod_att.op = WITNESS_FS_MODIFY;
    fs_mod_att.phase = WITNESS_PHASE_ATTEMPTED;
    fs_mod_att.dev = 2049;
    fs_mod_att.inode = 90001;
    fs_mod_att.bytes = 64;
    fs_mod_att.path = "out.txt";
    raw.push_back(fs_mod_att);

    ObservedEvent fs_mod_comp = fs_mod_att;
    fs_mod_comp.seq = 5;
    fs_mod_comp.timestamp_ns = 1250;
    fs_mod_comp.phase = WITNESS_PHASE_COMPLETED;
    fs_mod_comp.result_errno = 0;
    raw.push_back(fs_mod_comp);

    // 4. Failed DELETE attempt on /etc/shadow (EACCES = 13)
    ObservedEvent fs_del_att = make_ev(6, 1300, cg, EventType::Fs, 500, 1, 0, 0, "python3");
    fs_del_att.op = WITNESS_FS_DELETE;
    fs_del_att.phase = WITNESS_PHASE_ATTEMPTED;
    fs_del_att.path = "/etc/shadow";
    raw.push_back(fs_del_att);

    ObservedEvent fs_del_comp = fs_del_att;
    fs_del_comp.seq = 7;
    fs_del_comp.timestamp_ns = 1350;
    fs_del_comp.phase = WITNESS_PHASE_COMPLETED;
    fs_del_comp.result_errno = 13;
    raw.push_back(fs_del_comp);

    // 5. RENAME /workspace/out.txt -> /workspace/final.txt
    ObservedEvent fs_ren_att = make_ev(8, 1400, cg, EventType::Fs, 500, 1, 0, 0, "python3");
    fs_ren_att.op = WITNESS_FS_RENAME;
    fs_ren_att.phase = WITNESS_PHASE_ATTEMPTED;
    fs_ren_att.path = "/workspace/out.txt";
    fs_ren_att.target_path = "/workspace/final.txt";
    raw.push_back(fs_ren_att);

    ObservedEvent fs_ren_comp = fs_ren_att;
    fs_ren_comp.seq = 9;
    fs_ren_comp.timestamp_ns = 1450;
    fs_ren_comp.phase = WITNESS_PHASE_COMPLETED;
    fs_ren_comp.dev = 2049;
    fs_ren_comp.inode = 90001;
    fs_ren_comp.result_errno = 0;
    raw.push_back(fs_ren_comp);

    // 6.EXIT
    raw.push_back(make_ev(10, 1500, cg, EventType::Exit, 500, 1, 0, 0, "python3"));

    // Privacy-preserving default (displayPath == null)
    ReconstructionOptions opts_priv;
    opts_priv.hmac_key = "test-hmac-secret";
    opts_priv.include_display_paths = false;
    auto recon_priv = reconstruct_process_tree(raw, cg, 500, opts_priv);
    assert(recon_priv.sequence_gaps == 0);
    assert(recon_priv.counts.filesystem == 8);
    assert(recon_priv.category_completeness.filesystem.status == "complete");
    assert(!recon_priv.filesystem_events[0].display_path.has_value());
    // MODIFY event (index 2) was enriched from "out.txt" to "/workspace/out.txt", so its pathDigest matches CREATE!
    assert(recon_priv.filesystem_events[2].path_digest == recon_priv.filesystem_events[0].path_digest);
    // Failed DELETE (index 5) has succeeded == false, resultErrno == 13
    assert(!recon_priv.filesystem_events[5].succeeded);
    assert(recon_priv.filesystem_events[5].result_errno == 13);
    // RENAME (index 7) has targetPathDigest
    assert(recon_priv.filesystem_events[7].target_path_digest.has_value());

    // Now add MMAP_WRITE and verify completeness downgrades to "partial" with unsupportedOperations
    ObservedEvent mmap_ev = make_ev(11, 1550, cg, EventType::Fs, 500, 1, 0, 0, "python3");
    mmap_ev.op = WITNESS_FS_MMAP_WRITE;
    mmap_ev.phase = WITNESS_PHASE_COMPLETED;
    mmap_ev.dev = 2049;
    mmap_ev.inode = 90001;
    mmap_ev.bytes = 4096;
    raw.push_back(mmap_ev);

    auto recon_partial = reconstruct_process_tree(raw, cg, 500, opts_priv);
    assert(recon_partial.category_completeness.filesystem.status == "partial");
    assert(!recon_partial.category_completeness.filesystem.unsupported_operations.empty());
    assert(recon_partial.category_completeness.filesystem.unsupported_operations[0] == "mmap_shared_write");
}

void test_phase5_network_ipv4_ipv6_tcp_udp_and_incomplete() {
    const uint64_t cg = 4444;
    std::vector<ObservedEvent> raw;
    raw.push_back(make_ev(1, 1000, cg, EventType::Exec, 600, 1, 0, 0, "curl"));

    // 1. IPv4 TCP connect to 93.184.216.34:443 -> connected
    ObservedEvent tcp4_att = make_ev(2, 1100, cg, EventType::Net, 600, 1, 0, 0, "curl");
    tcp4_att.op = WITNESS_NET_CONNECT;
    tcp4_att.phase = WITNESS_PHASE_ATTEMPTED;
    tcp4_att.outcome = WITNESS_NET_OUTCOME_ATTEMPTED;
    tcp4_att.sock_cookie = 1001;
    tcp4_att.af = AF_INET;
    tcp4_att.proto = IPPROTO_TCP;
    tcp4_att.remote_port = 443;
    inet_pton(AF_INET, "93.184.216.34", &tcp4_att.remote_ip4);
    raw.push_back(tcp4_att);

    ObservedEvent tcp4_st = tcp4_att;
    tcp4_st.seq = 3;
    tcp4_st.timestamp_ns = 1150;
    tcp4_st.op = WITNESS_NET_STATE_CHANGE;
    tcp4_st.phase = WITNESS_PHASE_STATE_CHANGE;
    tcp4_st.old_state = 2; // TCP_SYN_SENT
    tcp4_st.new_state = 1; // TCP_ESTABLISHED
    tcp4_st.outcome = WITNESS_NET_OUTCOME_CONNECTED;
    tcp4_st.local_port = 52000;
    raw.push_back(tcp4_st);

    ObservedEvent tcp4_comp = tcp4_att;
    tcp4_comp.seq = 4;
    tcp4_comp.timestamp_ns = 1160;
    tcp4_comp.phase = WITNESS_PHASE_COMPLETED;
    tcp4_comp.outcome = WITNESS_NET_OUTCOME_CONNECTED;
    tcp4_comp.local_port = 52000;
    raw.push_back(tcp4_comp);

    // 2. IPv6 TCP connect to [2001:db8::1]:8443 -> ECONNREFUSED (111)
    ObservedEvent tcp6_att = make_ev(5, 1200, cg, EventType::Net, 600, 1, 0, 0, "curl");
    tcp6_att.op = WITNESS_NET_CONNECT;
    tcp6_att.phase = WITNESS_PHASE_ATTEMPTED;
    tcp6_att.outcome = WITNESS_NET_OUTCOME_ATTEMPTED;
    tcp6_att.sock_cookie = 1002;
    tcp6_att.af = AF_INET6;
    tcp6_att.proto = IPPROTO_TCP;
    tcp6_att.remote_port = 8443;
    inet_pton(AF_INET6, "2001:db8::1", tcp6_att.remote_ip6.data());
    raw.push_back(tcp6_att);

    ObservedEvent tcp6_comp = tcp6_att;
    tcp6_comp.seq = 6;
    tcp6_comp.timestamp_ns = 1250;
    tcp6_comp.phase = WITNESS_PHASE_COMPLETED;
    tcp6_comp.outcome = WITNESS_NET_OUTCOME_REFUSED;
    tcp6_comp.result_errno = 111;
    raw.push_back(tcp6_comp);

    // 3. UDPv4 sendmsg to 8.8.8.8:53 (32 bytes)
    ObservedEvent udp4_comp = make_ev(7, 1300, cg, EventType::Net, 600, 1, 0, 0, "curl");
    udp4_comp.op = WITNESS_NET_SENDMSG;
    udp4_comp.phase = WITNESS_PHASE_COMPLETED;
    udp4_comp.outcome = WITNESS_NET_OUTCOME_CONNECTED;
    udp4_comp.sock_cookie = 1003;
    udp4_comp.af = AF_INET;
    udp4_comp.proto = IPPROTO_UDP;
    udp4_comp.remote_port = 53;
    udp4_comp.bytes = 32;
    inet_pton(AF_INET, "8.8.8.8", &udp4_comp.remote_ip4);
    raw.push_back(udp4_comp);

    raw.push_back(make_ev(8, 1400, cg, EventType::Exit, 600, 1, 0, 0, "curl"));

    ReconstructionOptions ropts;
    ropts.include_display_remote_addrs = true;
    auto recon = reconstruct_process_tree(raw, cg, 600, ropts);
    assert(recon.sequence_gaps == 0);
    assert(recon.counts.network == 6);
    assert(recon.category_completeness.network.status == "complete");
    assert(recon.network_events[1].state_transition.value() == "TCP_SYN_SENT->TCP_ESTABLISHED");
    assert(recon.network_events[1].display_remote_addr.value() == "93.184.216.34");
    assert(recon.network_events[4].af == "INET6");
    assert(recon.network_events[4].outcome == "refused");
    assert(recon.network_events[4].errno_val == 111);
    assert(recon.network_events[5].proto == "UDP");
    assert(recon.network_events[5].bytes == 32);

    // 4. Add an in-flight TCP connection (EINPROGRESS without terminal state before exit)
    ObservedEvent inflight = make_ev(9, 1450, cg, EventType::Net, 600, 1, 0, 0, "curl");
    inflight.op = WITNESS_NET_CONNECT;
    inflight.phase = WITNESS_PHASE_COMPLETED;
    inflight.outcome = WITNESS_NET_OUTCOME_IN_PROGRESS;
    inflight.result_errno = 115;
    inflight.sock_cookie = 1004;
    inflight.af = AF_INET;
    inflight.proto = IPPROTO_TCP;
    inflight.remote_port = 9999;
    raw.push_back(inflight);

    auto recon_inc = reconstruct_process_tree(raw, cg, 600, ropts);
    assert(recon_inc.category_completeness.network.status == "partial");
    assert(recon_inc.network_events.back().outcome == "incomplete");
}

void test_phase6_v1_and_v2_domain_separation_and_category_tamper() {
    auto [priv, pub] = generate_ephemeral_ed25519_keypair_pem();
    const uint64_t cg = 5555;
    auto recon = reconstruct_process_tree({
        make_ev(1, 1000, cg, EventType::Exec, 800, 1, 0, 0, "sh"),
        make_ev(2, 1100, cg, EventType::Exit, 800, 1, 0, 0, "sh"),
    }, cg, 800);

    ObservationReceipt r_v2;
    r_v2.schema_version = kReceiptSchemaVersionV2;
    r_v2.observer_mode = "live";
    r_v2.observer_id = "obs-v2";
    r_v2.work_item_id = "wi-v2";
    r_v2.attempt_id = "att-v2";
    r_v2.lease_id = "lease-v2";
    r_v2.invocation_hash = "inv-v2";
    r_v2.cgroup_id = cg;
    r_v2.cgroup_path = "/sys/fs/cgroup/v2";
    r_v2.root_pid = 800;
    r_v2.start_time_ns = recon.start_time_ns;
    r_v2.end_time_ns = recon.end_time_ns;
    r_v2.events = recon.events;
    r_v2.process_tree = recon.process_tree;
    r_v2.category_completeness = recon.category_completeness;
    r_v2.event_counts = recon.counts;
    finalize_and_sign_receipt(r_v2, priv, false);

    VerificationOptions opts;
    opts.require_v2 = true;
    opts.required_categories = {"process", "filesystem", "network"};
    JsonValue j_v2 = receipt_to_json(r_v2);
    assert(verify_receipt(j_v2, pub, opts, false).valid);

    // Tamper with filesystem categoryDigestSha256 -> MUST fail verification
    JsonValue j_bad_cat = j_v2;
    j_bad_cat.as_object_mut()["categoryCompleteness"]
        .as_object_mut()["filesystem"]
        .as_object_mut()["categoryDigestSha256"] = "0000000000000000000000000000000000000000000000000000000000000000";
    auto vr_bad_cat = verify_receipt(j_bad_cat, pub, opts, false);
    assert(!vr_bad_cat.valid);

    // Legacy v1 receipt still verifies when require_v2 == false
    ObservationReceipt r_v1 = r_v2;
    r_v1.schema_version = kReceiptSchemaVersionV1;
    r_v1.evidence_hash.clear();
    r_v1.signature.clear();
    finalize_and_sign_receipt(r_v1, priv, false);
    VerificationOptions opts_v1;
    opts_v1.require_v2 = false;
    assert(verify_receipt(receipt_to_json(r_v1), pub, opts_v1, false).valid);
}

} // namespace

int main() {
    RUN_TEST(test_canonical_json_and_ed25519);
    RUN_TEST(test_process_tree_3_subprocesses_and_cgroup_filter);
    RUN_TEST(test_sequence_gap_and_ringbuf_overflow_rejected);
    RUN_TEST(test_malformed_event_handling);
    RUN_TEST(test_hash_chain_tamper_replay_and_correlation);
    RUN_TEST(test_bpf_object_open_and_btf_check);
    RUN_TEST(test_pre_exec_cgroup_v2_lifecycle);
    RUN_TEST(test_root_fork_exec_3_subprocesses_and_root_pid_verification);
    RUN_TEST(test_p0_01_keygen_permissions_0600);
    RUN_TEST(test_p1_04_clone_thread_no_self_loop_or_exit_clobber);
    RUN_TEST(test_p1_05_non_utf8_comm_and_path_sanitization);
    RUN_TEST(test_p2_01_concurrent_flock_replay_protection);
    RUN_TEST(test_phase2_signerd_broker_peercred_and_audit_chain);
    RUN_TEST(test_phase2_key_lifecycle_register_rotate_retire_revoke);
    RUN_TEST(test_phase4_filesystem_events_hmac_digest_and_completeness);
    RUN_TEST(test_phase5_network_ipv4_ipv6_tcp_udp_and_incomplete);
    RUN_TEST(test_phase6_v1_and_v2_domain_separation_and_category_tamper);
    std::cout << "All " << g_tests_run << " tests passed.\n";
    return 0;
}
