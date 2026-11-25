//! Protocol v2 tests with fake host commands. The fake launcher strips leading
//! `--flags` (as systemd-run consumes them) and execs the rest; the fake
//! systemctl records its calls and reports a configurable scope state.

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use serde_json::{Value, json};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new(scope_state: &str) -> Self {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("acs-supervise-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        write_script(
            &dir.join("fake-run"),
            "#!/bin/sh\nwhile [ $# -gt 0 ]; do case \"$1\" in --*) shift;; *) break;; esac; done\nexec \"$@\"\n",
        );
        let log = dir.join("systemctl.log");
        let systemctl = match scope_state {
            "inactive" => format!(
                "#!/bin/sh\necho \"$*\" >> {log}\ncase \"$2\" in is-active) echo inactive; exit 3;; kill) exit 0;; esac\nexit 1\n",
                log = log.display()
            ),
            "active" => format!(
                "#!/bin/sh\necho \"$*\" >> {log}\ncase \"$2\" in is-active) echo active; exit 0;; kill) exit 0;; esac\nexit 1\n",
                log = log.display()
            ),
            "kill-fails" => format!(
                "#!/bin/sh\necho \"$*\" >> {log}\ncase \"$2\" in is-active) echo inactive; exit 3;; kill) echo denied >&2; exit 1;; esac\nexit 1\n",
                log = log.display()
            ),
            other => panic!("unknown state {other}"),
        };
        write_script(&dir.join("fake-systemctl"), &systemctl);
        Self { dir }
    }

    fn path(&self, name: &str) -> String {
        self.dir.join(name).display().to_string()
    }

    fn systemctl_log(&self) -> String {
        fs::read_to_string(self.dir.join("systemctl.log")).unwrap_or_default()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn write_script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

const UNIT: &str = "acs-sandbox-attempt-1-abcd1234.scope";
const SESSION: &str = "ss-0123456789abcdef0123";

fn start_frame(fixture: &Fixture, script: &str, wall_ms: u64, output_bytes: u64) -> Value {
    json!({
        "version": 2,
        "type": "start",
        "session": {
            "sessionId": SESSION,
            "workItemId": "wi-1",
            "attemptId": "attempt-1",
            "leaseId": "lease-1",
            "workerId": "worker-1",
            "fencingToken": 7,
            "unitName": UNIT
        },
        "command": fixture.path("fake-run"),
        "args": ["--user", "--scope", format!("--unit={UNIT}"), "/bin/sh", "-c", script],
        "environment": {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        "systemctlPath": fixture.path("fake-systemctl"),
        "limits": {"wallClockMs": wall_ms, "terminationGraceMs": 50, "outputBytes": output_bytes}
    })
}

fn spawn_helper() -> Child {
    Command::new(env!("CARGO_BIN_EXE_acs-scope-supervisor"))
        .arg("supervise")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn line(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).unwrap();
    bytes.push(b'\n');
    bytes
}

/// Sends the start frame and the given raw control bytes, keeps stdin open
/// (unless `close`), and returns the single output frame and exit success.
fn exchange(start: &Value, control: &[&[u8]], close: bool) -> (Value, bool) {
    let mut child = spawn_helper();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&line(start)).unwrap();
    for frame in control {
        stdin.write_all(frame).unwrap();
    }
    stdin.flush().unwrap();
    let keep = if close {
        drop(stdin);
        None
    } else {
        Some(stdin)
    };
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut text = String::new();
    reader.read_line(&mut text).unwrap();
    drop(keep);
    let status = child.wait().unwrap();
    let mut rest = String::new();
    reader.read_line(&mut rest).unwrap();
    assert!(
        rest.is_empty(),
        "exactly one frame expected, got trailing {rest:?}"
    );
    (serde_json::from_str(&text).unwrap(), status.success())
}

fn decode(value: &Value) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let text = value.as_str().unwrap().trim_end_matches('=');
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for c in text.bytes() {
        acc = (acc << 6) | ALPHABET.iter().position(|&a| a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn cancel(seq: u32, session: &str, fence: u64) -> Vec<u8> {
    line(
        &json!({"version": 2, "sessionId": session, "fencingToken": fence, "seq": seq, "event": {"type": "cancel"}}),
    )
}

#[test]
fn exit_is_observed_with_bindings_output_and_verified_cleanup() {
    let fixture = Fixture::new("inactive");
    let (obs, ok) = exchange(
        &start_frame(
            &fixture,
            "printf 'hello\\n'; printf 'oops' >&2; exit 0",
            5000,
            4096,
        ),
        &[],
        false,
    );
    assert!(ok);
    assert_eq!(obs["type"], "observation");
    assert_eq!(obs["sessionId"], SESSION);
    assert_eq!(obs["attemptId"], "attempt-1");
    assert_eq!(obs["leaseId"], "lease-1");
    assert_eq!(obs["fencingToken"], 7);
    assert_eq!(obs["unitName"], UNIT);
    assert_eq!(obs["exitCode"], 0);
    assert_eq!(obs["trigger"], Value::Null);
    assert_eq!(obs["cleanup"], "verified");
    assert_eq!(decode(&obs["stdout"]), b"hello\n");
    assert_eq!(decode(&obs["stderr"]), b"oops");
    assert_eq!(obs["stdoutBytes"], 6);
    assert_eq!(obs["parentLost"], false);
    assert_eq!(obs["protocolViolation"], Value::Null);
    assert!(
        fixture
            .systemctl_log()
            .contains(&format!("--user is-active {UNIT}"))
    );
}

#[test]
fn nonzero_exit_and_combined_output_cap() {
    let fixture = Fixture::new("inactive");
    let (obs, _) = exchange(
        &start_frame(
            &fixture,
            "head -c 5000 /dev/zero | tr '\\0' a; exit 3",
            5000,
            1024,
        ),
        &[],
        false,
    );
    assert_eq!(obs["exitCode"], 3);
    assert_eq!(obs["stdoutBytes"], 1024);
    assert_eq!(obs["stdoutTruncated"], true);
    assert_eq!(decode(&obs["stdout"]).len(), 1024);
}

#[test]
fn deadline_terminates_the_process_group_and_its_descendants() {
    let fixture = Fixture::new("inactive");
    let marker = format!(
        "{}.{}",
        40 + COUNTER.fetch_add(1, Ordering::SeqCst),
        std::process::id()
    );
    let started = Instant::now();
    let (obs, _) = exchange(
        &start_frame(
            &fixture,
            &format!("sleep {marker} & sleep {marker}; wait"),
            300,
            4096,
        ),
        &[],
        false,
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(obs["trigger"], "timeout");
    assert_eq!(obs["signal"], "SIGTERM");
    assert_eq!(obs["cleanup"], "verified");
    let log = fixture.systemctl_log();
    assert!(log.contains(&format!(
        "--user kill --kill-whom=all --signal=SIGTERM {UNIT}"
    )));
    std::thread::sleep(Duration::from_millis(100));
    let survivors = Command::new("pgrep")
        .args(["-f", &format!("sleep {marker}")])
        .output()
        .unwrap();
    assert!(
        survivors.stdout.is_empty(),
        "descendants survived: {:?}",
        survivors
    );
}

#[test]
fn grace_escalates_to_kill_when_term_is_ignored() {
    let fixture = Fixture::new("inactive");
    let (obs, _) = exchange(
        &start_frame(
            &fixture,
            "trap '' TERM; while :; do sleep 0.01; done",
            200,
            4096,
        ),
        &[],
        false,
    );
    assert_eq!(obs["trigger"], "timeout");
    assert_eq!(obs["signal"], "SIGKILL");
    assert!(fixture.systemctl_log().contains("--signal=SIGKILL"));
}

#[test]
fn bound_cancel_is_accepted() {
    let fixture = Fixture::new("inactive");
    let (obs, _) = exchange(
        &start_frame(&fixture, "sleep 30", 10_000, 4096),
        &[&cancel(1, SESSION, 7)],
        false,
    );
    assert_eq!(obs["trigger"], "cancelled");
    assert_eq!(obs["protocolViolation"], Value::Null);
    assert_eq!(obs["parentLost"], false);
}

fn violation(control: &[u8]) -> Value {
    let fixture = Fixture::new("inactive");
    let (obs, _) = exchange(
        &start_frame(&fixture, "sleep 30", 10_000, 4096),
        &[control],
        false,
    );
    assert_eq!(
        obs["trigger"], "cancelled",
        "violations must stop the workload"
    );
    obs["protocolViolation"].clone()
}

#[test]
fn stale_fence_is_rejected_and_stops_the_workload() {
    assert_eq!(violation(&cancel(1, SESSION, 6)), "control_fence_stale");
}

#[test]
fn foreign_session_is_rejected() {
    assert_eq!(
        violation(&cancel(1, "ss-ffffffffffffffffffff", 7)),
        "control_session_mismatch"
    );
}

#[test]
fn out_of_order_and_replayed_sequences_are_rejected() {
    assert_eq!(
        violation(&cancel(2, SESSION, 7)),
        "control_seq_out_of_order"
    );
    let fixture = Fixture::new("inactive");
    let first = cancel(1, SESSION, 7);
    let (obs, _) = exchange(
        &start_frame(&fixture, "trap '' TERM; sleep 1", 10_000, 4096),
        &[&first, &first],
        false,
    );
    assert_eq!(obs["protocolViolation"], "control_seq_out_of_order");
}

#[test]
fn malformed_and_oversized_frames_are_rejected() {
    assert_eq!(violation(b"{not json}\n"), "control_frame_malformed");
    assert_eq!(
        violation(&line(
            &json!({"version": 2, "sessionId": SESSION, "fencingToken": 7, "seq": 1, "event": {"type": "kill_everything"}})
        )),
        "control_frame_malformed"
    );
    let big = vec![b' '; 2048];
    assert_eq!(violation(&big), "control_frame_invalid");
}

#[test]
fn parent_loss_stops_the_workload_and_is_reported() {
    let fixture = Fixture::new("inactive");
    let (obs, _) = exchange(&start_frame(&fixture, "sleep 30", 10_000, 4096), &[], true);
    assert_eq!(obs["parentLost"], true);
    assert_eq!(obs["trigger"], "cancelled");
}

#[test]
fn persistent_scope_is_reported_as_failed_cleanup() {
    let fixture = Fixture::new("active");
    let (obs, _) = exchange(&start_frame(&fixture, "exit 0", 5000, 4096), &[], false);
    assert_eq!(obs["cleanup"], "failed");
}

#[test]
fn failed_scope_signal_is_recorded() {
    let fixture = Fixture::new("kill-fails");
    let (obs, _) = exchange(&start_frame(&fixture, "sleep 30", 200, 4096), &[], false);
    assert_eq!(obs["trigger"], "timeout");
    assert_eq!(obs["signalFailed"], true);
    assert!(obs["terminationError"].as_str().unwrap().contains("denied"));
}

#[test]
fn launch_failure_is_observed() {
    let fixture = Fixture::new("inactive");
    let mut start = start_frame(&fixture, "true", 5000, 4096);
    start["command"] = json!(fixture.path("missing-launcher"));
    let (obs, _) = exchange(&start, &[], false);
    assert!(
        obs["launchError"]
            .as_str()
            .unwrap()
            .starts_with("spawn failed")
    );
    assert_eq!(obs["exitCode"], Value::Null);
}

#[test]
fn workload_sees_only_the_explicit_environment_and_no_control_channel() {
    let fixture = Fixture::new("inactive");
    let (obs, _) = exchange(
        &start_frame(
            &fixture,
            "env | sort; ls /proc/$$/fd | tr '\\n' ' '; readlink /proc/$$/fd/0",
            5000,
            8192,
        ),
        &[],
        false,
    );
    let stdout = String::from_utf8(decode(&obs["stdout"])).unwrap();
    let mut lines = stdout.lines();
    let env: Vec<_> = lines
        .by_ref()
        .take_while(|l| l.contains('='))
        .filter(|l| !l.starts_with("PWD=") && !l.starts_with("SHLVL=") && !l.starts_with("_="))
        .collect();
    assert_eq!(env, ["LANG=C.UTF-8", "PATH=/usr/bin:/bin"], "{stdout}");
    assert!(stdout.contains("/dev/null"), "{stdout}");
    let fds = stdout
        .lines()
        .find(|l| l.trim_start().starts_with('0'))
        .unwrap_or_default();
    let count = fds.split_whitespace().count();
    assert!(count <= 4, "unexpected inherited descriptors: {fds}");
}

fn rejected(mutate: impl FnOnce(&mut Value)) -> String {
    let fixture = Fixture::new("inactive");
    let marker = fixture.path("launched");
    let mut start = start_frame(&fixture, &format!("touch {marker}"), 5000, 4096);
    mutate(&mut start);
    let (frame, ok) = exchange(&start, &[], true);
    assert!(!ok);
    assert_eq!(frame["type"], "rejected");
    assert!(
        !Path::new(&marker).exists(),
        "rejected session must not launch"
    );
    assert_eq!(fixture.systemctl_log(), "");
    frame["code"].as_str().unwrap().to_owned()
}

#[test]
fn invalid_start_requests_launch_nothing() {
    assert_eq!(
        rejected(|s| s["args"][2] = json!("--unit=acs-sandbox-other-1.scope")),
        "scope_binding_invalid"
    );
    assert_eq!(
        rejected(|s| s["args"].as_array_mut().unwrap().push(json!("--unit=x"))),
        "scope_binding_invalid"
    );
    assert_eq!(
        rejected(|s| s["session"]["unitName"] = json!("user@1000.service")),
        "unit_name_invalid"
    );
    assert_eq!(
        rejected(|s| s["command"] = json!("fake-run")),
        "executable_path_invalid"
    );
    assert_eq!(
        rejected(|s| s["systemctlPath"] = json!("/usr/../bin/systemctl")),
        "executable_path_invalid"
    );
    assert_eq!(
        rejected(|s| s["session"]["fencingToken"] = json!(0)),
        "fencing_token_invalid"
    );
    assert_eq!(
        rejected(|s| s["session"]["sessionId"] = json!("short")),
        "session_id_invalid"
    );
    assert_eq!(
        rejected(|s| s["session"]["attemptId"] = json!("../etc")),
        "session_binding_invalid"
    );
    assert_eq!(
        rejected(|s| s["environment"]["LD_PRELOAD\n"] = json!("x")),
        "environment_invalid"
    );
    assert_eq!(
        rejected(|s| s["environment"]["TOKEN"] = json!("a\nb")),
        "environment_invalid"
    );
    assert_eq!(
        rejected(|s| s["limits"]["outputBytes"] = json!(10)),
        "limits_invalid"
    );
    assert_eq!(
        rejected(|s| s["limits"]["wallClockMs"] = json!(0)),
        "limits_invalid"
    );
    assert_eq!(
        rejected(|s| s["version"] = json!(1)),
        "request_version_unsupported"
    );
    assert_eq!(rejected(|s| s["extra"] = json!(true)), "request_malformed");
}

#[test]
fn stdin_is_delivered_and_must_be_canonical_base64() {
    let fixture = Fixture::new("inactive");
    let mut start = start_frame(&fixture, "cat", 5000, 4096);
    start["stdin"] = json!("aGVsbG8gc3RkaW4=");
    let (obs, _) = exchange(&start, &[], false);
    assert_eq!(decode(&obs["stdout"]), b"hello stdin");
    assert_eq!(
        rejected(|s| s["stdin"] = json!("aGVsbG8=x")),
        "stdin_invalid"
    );
    assert_eq!(
        rejected(|s| s["stdin"] = json!("aGVsbG9=")),
        "stdin_invalid"
    );
    let fixture = Fixture::new("inactive");
    let (obs, _) = exchange(
        &start_frame(&fixture, "cat; echo done", 5000, 4096),
        &[],
        false,
    );
    assert_eq!(decode(&obs["stdout"]), b"done\n");
}

/// A control frame of exactly `total` bytes, counting its newline, padded with
/// trailing JSON whitespace. Limit: 1,024 bytes including LF.
fn padded_cancel(total: usize) -> Vec<u8> {
    let value = json!({"version": 2, "sessionId": SESSION, "fencingToken": 7, "seq": 1, "event": {"type": "cancel"}});
    let mut bytes = serde_json::to_vec(&value).unwrap();
    assert!(
        total > bytes.len() + 1,
        "frame too small for the cancel body"
    );
    bytes.extend(std::iter::repeat_n(b' ', total - 1 - bytes.len()));
    bytes.push(b'\n');
    assert_eq!(bytes.len(), total);
    bytes
}

#[test]
fn control_frame_limit_is_exact_including_the_newline() {
    let fixture = Fixture::new("inactive");
    let (obs, _) = exchange(
        &start_frame(&fixture, "sleep 30", 10_000, 4096),
        &[&padded_cancel(1024)],
        false,
    );
    assert_eq!(obs["trigger"], "cancelled");
    assert_eq!(
        obs["protocolViolation"],
        Value::Null,
        "1,024 bytes with LF is within the limit"
    );

    assert_eq!(
        violation(&padded_cancel(1025)),
        "control_frame_invalid",
        "1,025 bytes with LF exceeds the limit"
    );
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn oversized_stdin_is_rejected_before_launch() {
    // One byte over the 4 MiB stdin bound, base64 encoded. The frame itself stays under the request bound.
    let oversized = base64_encode(&vec![b'a'; 4 * 1024 * 1024 + 1]);
    assert_eq!(rejected(|s| s["stdin"] = json!(oversized)), "stdin_invalid");
}
