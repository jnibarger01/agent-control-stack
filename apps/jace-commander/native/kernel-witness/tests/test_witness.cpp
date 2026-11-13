#include "witness/canonical_json.hpp"
#include "witness/cgroup.hpp"
#include "witness/crypto.hpp"
#include "witness/observer.hpp"
#include "witness/process_tree.hpp"
#include "witness/receipt.hpp"

#include <cassert>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <sys/wait.h>
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
        // Root process 100 execs sh
        make_ev(1, 1000, target_cg, EventType::Exec, 100, 1, 0, 0, "sh"),
        // Unrelated cgroup event MUST be excluded
        make_ev(2, 1050, foreign_cg, EventType::Exec, 888, 1, 0, 0, "evil"),
        // Root 100 forks child 101
        make_ev(2, 1100, target_cg, EventType::Fork, 100, 1, 101, 0, "sh"),
        make_ev(3, 1200, target_cg, EventType::Exec, 101, 100, 0, 0, "python3"),
        // Child 101 forks grandchild 102
        make_ev(4, 1300, target_cg, EventType::Fork, 101, 100, 102, 0, "python3"),
        make_ev(5, 1400, target_cg, EventType::Exec, 102, 101, 0, 0, "ls"),
        make_ev(6, 1500, target_cg, EventType::Exit, 102, 101, 0, 0, "ls"),
        make_ev(7, 1600, target_cg, EventType::Exit, 101, 100, 0, 0, "python3"),
        // Root 100 forks child 103
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
    assert(root.children.size() == 2); // 101 and 103
    assert(root.children[0].tgid == 101);
    assert(root.children[0].comm == "python3");
    assert(root.children[0].children.size() == 1); // 102
    assert(root.children[0].children[0].tgid == 102);
    assert(root.children[0].children[0].comm == "ls");
    assert(root.children[1].tgid == 103);
    assert(root.children[1].comm == "echo");
}

void test_sequence_gap_and_ringbuf_overflow_rejected() {
    auto [priv, pub] = generate_ephemeral_ed25519_keypair_pem();
    const uint64_t cg = 100;

    // Missing seq 2 -> sequence_gaps == 1
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

    // Even if an attacker flips status to "complete" and clears incompleteReasons,
    // droppedEvents > 0, sequenceGaps > 0, and signature mismatch MUST reject!
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
    r1.event_counts = recon.counts;
    r1.status = "complete";
    finalize_and_sign_receipt(r1, priv, false);

    // Chained receipt r2
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

    // 1. Valid verification succeeds and records hash
    JsonValue j2 = receipt_to_json(r2);
    auto v_ok = verify_receipt(j2, pub, opts, false);
    assert(v_ok.valid);

    // 2. Replay of exact same receipt MUST fail
    auto v_replay = verify_receipt(j2, pub, opts, false);
    assert(!v_replay.valid);

    // 3. Tampering a field MUST fail
    opts.seen_hashes_file.clear();
    JsonValue j2_tampered = j2;
    j2_tampered.as_object_mut()["cgroupId"] = static_cast<uint64_t>(777);
    auto v_tamper = verify_receipt(j2_tampered, pub, opts, false);
    assert(!v_tamper.valid);

    // 4. Mismatched ACS correlation ID MUST fail
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
    assert(res.programs.size() == 3);
    assert(res.maps.size() >= 3);
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

    // Verify the child was born inside our exact leaf cgroup BEFORE any user code ran
    std::string leaf_name = std::filesystem::path(leaf.path).filename().string();
    assert(child_cg.find(leaf_name) != std::string::npos);

    assert(cleanup_witness_cgroup_leaf(leaf));
    assert(!std::filesystem::exists(leaf.path));
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
    std::cout << "All " << g_tests_run << " tests passed.\n";
    return 0;
}
