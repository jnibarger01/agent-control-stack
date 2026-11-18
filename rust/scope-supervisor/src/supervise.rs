//! Protocol version 2: one live supervised scope for one admitted ACS attempt.
//!
//! ACS verifies authority, renders the systemd/bubblewrap invocation and owns
//! redaction and result acceptance. This helper owns process creation, the
//! deadline and grace timers, signal delivery, raw bounded capture, reaping and
//! the terminal scope cleanup observation. Every control frame must carry the
//! session id and fencing token issued in the start request and a strictly
//! increasing sequence number. Any violation or loss of the parent channel
//! terminates the workload and is reported so ACS can classify the attempt as
//! unknown.

use std::{
    collections::BTreeMap,
    io::{self, BufRead, Read, Write},
    os::unix::process::{CommandExt, ExitStatusExt},
    process::{Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use nix::{
    sys::signal::{Signal as NixSignal, killpg},
    unistd::Pid,
};
use serde::{Deserialize, Serialize};

use crate::coordinator::{Coordinator, Effect, Event, Phase, Signal, Trigger};

pub(crate) const VERSION: u8 = 2;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_CONTROL_FRAME_BYTES: u64 = 1024;
const MAX_CONTROL_FRAMES: u32 = 16;
const MAX_ARGS: usize = 256;
const MAX_ARG_BYTES: usize = 8 * 1024;
const MAX_ENV_ENTRIES: usize = 32;
const MAX_PROBE_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_ERROR_BYTES: usize = 4096;
const READ_CHUNK_BYTES: usize = 8 * 1024;
/// Extra time after deadline + grace before the helper abandons a launcher
/// that never closes and reports cleanup as unknown.
const HARD_STOP_SLACK: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Session {
    session_id: String,
    work_item_id: String,
    attempt_id: String,
    lease_id: String,
    worker_id: String,
    fencing_token: u64,
    unit_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Limits {
    wall_clock_ms: u64,
    termination_grace_ms: u64,
    output_bytes: usize,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RequestType {
    Start,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    version: u8,
    #[serde(rename = "type")]
    kind: RequestType,
    session: Session,
    command: String,
    args: Vec<String>,
    environment: BTreeMap<String, String>,
    systemctl_path: String,
    limits: Limits,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ControlEvent {
    Cancel {},
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Control {
    version: u8,
    session_id: String,
    fencing_token: u64,
    seq: u32,
    event: ControlEvent,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rejected<'a> {
    version: u8,
    #[serde(rename = "type")]
    kind: &'static str,
    code: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation<'a> {
    version: u8,
    #[serde(rename = "type")]
    kind: &'static str,
    session_id: &'a str,
    work_item_id: &'a str,
    attempt_id: &'a str,
    lease_id: &'a str,
    worker_id: &'a str,
    fencing_token: u64,
    unit_name: &'a str,
    trigger: Option<Trigger>,
    signal_failed: bool,
    termination_error: Option<String>,
    launch_error: Option<String>,
    exit_code: Option<i32>,
    signal: Option<&'static str>,
    cleanup: &'static str,
    stdout: String,
    stderr: String,
    stdout_bytes: usize,
    stderr_bytes: usize,
    stdout_truncated: bool,
    stderr_truncated: bool,
    protocol_violation: Option<&'static str>,
    parent_lost: bool,
    abandoned: bool,
    duration_ms: u64,
}

#[derive(Default)]
struct Capture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

impl Capture {
    /// Mirrors `captureChunk`: one combined raw budget across both streams.
    fn push(&mut self, stdout: bool, chunk: &[u8], maximum: usize) {
        let used = self.stdout.len() + self.stderr.len();
        let remaining = maximum.saturating_sub(used);
        let take = remaining.min(chunk.len());
        let (buffer, truncated) = if stdout {
            (&mut self.stdout, &mut self.stdout_truncated)
        } else {
            (&mut self.stderr, &mut self.stderr_truncated)
        };
        buffer.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            *truncated = true;
        }
    }
}

enum Message {
    Cancel,
    Violation(&'static str),
    ParentLost,
    SignalDone {
        signal: Signal,
        failed: bool,
        error: Option<String>,
    },
    Closed(Option<ExitStatus>),
}

pub(crate) fn run(
    mut input: impl BufRead + Send + 'static,
    mut output: impl Write,
) -> io::Result<()> {
    let request = match read_request(&mut input) {
        Ok(request) => request,
        Err(code) => {
            write_frame(
                &mut output,
                &Rejected {
                    version: VERSION,
                    kind: "rejected",
                    code,
                },
            )?;
            return Err(io::Error::new(io::ErrorKind::InvalidData, code));
        }
    };
    let observation = supervise(&request, input);
    write_frame(&mut output, &observation)
}

fn write_frame(output: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn read_request(input: &mut impl BufRead) -> Result<Request, &'static str> {
    let mut frame = Vec::new();
    input
        .take(MAX_REQUEST_BYTES)
        .read_until(b'\n', &mut frame)
        .map_err(|_| "request_unreadable")?;
    if frame.pop() != Some(b'\n') {
        return Err("request_frame_invalid");
    }
    let request: Request = serde_json::from_slice(&frame).map_err(|_| "request_malformed")?;
    validate(&request)?;
    Ok(request)
}

fn is_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn is_unit_name(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("acs-sandbox-")
        .or_else(|| value.strip_prefix("acs-engine-"))
    else {
        return false;
    };
    let Some(stem) = rest.strip_suffix(".scope") else {
        return false;
    };
    let bytes = stem.as_bytes();
    value.len() <= 128
        && !bytes.is_empty()
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
        })
}

fn is_normalized_absolute(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 4096
        && !path.contains('\0')
        && (path == "/"
            || (!path.ends_with('/')
                && path[1..]
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")))
}

fn is_env_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_uppercase() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

pub(crate) fn validate(request: &Request) -> Result<(), &'static str> {
    if request.version != VERSION || request.kind != RequestType::Start {
        return Err("request_version_unsupported");
    }
    let session = &request.session;
    if session.session_id.len() < 16 || !is_identifier(&session.session_id) {
        return Err("session_id_invalid");
    }
    for id in [
        &session.work_item_id,
        &session.attempt_id,
        &session.lease_id,
        &session.worker_id,
    ] {
        if !is_identifier(id) {
            return Err("session_binding_invalid");
        }
    }
    if session.fencing_token == 0 || session.fencing_token > (1 << 53) {
        return Err("fencing_token_invalid");
    }
    if !is_unit_name(&session.unit_name) {
        return Err("unit_name_invalid");
    }
    if !is_normalized_absolute(&request.command) || !is_normalized_absolute(&request.systemctl_path)
    {
        return Err("executable_path_invalid");
    }
    if request.args.len() > MAX_ARGS
        || request
            .args
            .iter()
            .any(|arg| arg.len() > MAX_ARG_BYTES || arg.contains('\0'))
    {
        return Err("arguments_invalid");
    }
    // The invocation must create exactly the transient scope this session owns.
    let unit_flag = format!("--unit={}", session.unit_name);
    let unit_flags = request
        .args
        .iter()
        .filter(|arg| arg.starts_with("--unit="))
        .count();
    if request.args.get(..2) != Some(&["--user".to_owned(), "--scope".to_owned()][..])
        || unit_flags != 1
        || !request.args.contains(&unit_flag)
    {
        return Err("scope_binding_invalid");
    }
    if request.environment.len() > MAX_ENV_ENTRIES
        || request.environment.iter().any(|(name, value)| {
            !is_env_name(name) || value.len() > 4096 || value.contains(['\0', '\r', '\n'])
        })
    {
        return Err("environment_invalid");
    }
    let limits = &request.limits;
    if !(100..=15 * 60 * 1000).contains(&limits.wall_clock_ms)
        || !(10..=5000).contains(&limits.termination_grace_ms)
        || !(1024..=1024 * 1024).contains(&limits.output_bytes)
    {
        return Err("limits_invalid");
    }
    Ok(())
}

fn spawn_control_reader(
    mut input: impl BufRead + Send + 'static,
    session_id: String,
    fencing_token: u64,
    tx: mpsc::Sender<Message>,
) {
    thread::spawn(move || {
        let mut frame = Vec::new();
        for expected in 1..=MAX_CONTROL_FRAMES + 1 {
            frame.clear();
            let read = (&mut input)
                .take(MAX_CONTROL_FRAME_BYTES)
                .read_until(b'\n', &mut frame);
            let message = match read {
                Ok(0) | Err(_) => Message::ParentLost,
                Ok(_) if frame.pop() != Some(b'\n') => Message::Violation("control_frame_invalid"),
                Ok(_) if expected > MAX_CONTROL_FRAMES => {
                    Message::Violation("control_frames_exhausted")
                }
                Ok(_) => match serde_json::from_slice::<Control>(&frame) {
                    Err(_) => Message::Violation("control_frame_malformed"),
                    Ok(control) if control.version != VERSION => {
                        Message::Violation("control_version_mismatch")
                    }
                    Ok(control) if control.session_id != session_id => {
                        Message::Violation("control_session_mismatch")
                    }
                    Ok(control) if control.fencing_token != fencing_token => {
                        Message::Violation("control_fence_stale")
                    }
                    Ok(control) if control.seq != expected => {
                        Message::Violation("control_seq_out_of_order")
                    }
                    Ok(Control {
                        event: ControlEvent::Cancel {},
                        ..
                    }) => Message::Cancel,
                },
            };
            let terminal = !matches!(message, Message::Cancel);
            if tx.send(message).is_err() || terminal {
                return;
            }
        }
    });
}

fn spawn_stream_reader(
    mut stream: impl Read + Send + 'static,
    is_stdout: bool,
    capture: Arc<Mutex<Capture>>,
    maximum: usize,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = vec![0u8; READ_CHUNK_BYTES];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => return,
                Ok(n) => {
                    if let Ok(mut capture) = capture.lock() {
                        capture.push(is_stdout, &buffer[..n], maximum);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return,
            }
        }
    })
}

fn signal_name(signal: Signal) -> &'static str {
    match signal {
        Signal::Term => "SIGTERM",
        Signal::Kill => "SIGKILL",
    }
}

fn nix_signal(signal: Signal) -> NixSignal {
    match signal {
        Signal::Term => NixSignal::SIGTERM,
        Signal::Kill => NixSignal::SIGKILL,
    }
}

fn bounded(prefix: &str, detail: &str) -> String {
    let detail = detail.trim();
    let mut value = if detail.is_empty() {
        prefix.to_owned()
    } else {
        format!("{prefix}: {detail}")
    };
    if value.len() > MAX_ERROR_BYTES {
        let mut end = MAX_ERROR_BYTES;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

pub(crate) struct HostResult {
    code: Option<i32>,
    signal: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs a host probe with a deadline and bounded output, like `runHostCommand`.
pub(crate) fn run_host_command(
    command: &str,
    args: &[&str],
    timeout: Duration,
) -> io::Result<HostResult> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let read_bounded = |mut stream: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut kept = Vec::new();
            let mut buffer = [0u8; 4096];
            while let Ok(n) = stream.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let room = MAX_PROBE_OUTPUT_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..n.min(room)]);
            }
            String::from_utf8_lossy(&kept).into_owned()
        })
    };
    let stdout = read_bounded(Box::new(child.stdout.take().expect("piped stdout")));
    let stderr = read_bounded(Box::new(child.stderr.take().expect("piped stderr")));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            break child.wait()?;
        }
        thread::sleep(Duration::from_millis(5));
    };
    Ok(HostResult {
        code: status.code(),
        signal: status.signal(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// Mirrors `signalScope`: a missing unit is not a failure.
fn signal_scope(systemctl: &str, unit: &str, signal: Signal) -> Result<(), String> {
    let flag = format!("--signal={}", signal_name(signal));
    let result = run_host_command(
        systemctl,
        &["--user", "kill", "--kill-whom=all", &flag, unit],
        Duration::from_secs(5),
    )
    .map_err(|error| bounded("failed to signal sandbox scope", &error.to_string()))?;
    let combined = format!("{}\n{}", result.stdout, result.stderr).to_lowercase();
    if result.code != Some(0)
        && !(combined.contains("not loaded")
            || combined.contains("not found")
            || combined.contains("could not be found"))
    {
        return Err(bounded("failed to signal sandbox scope", &result.stderr));
    }
    Ok(())
}

#[derive(PartialEq, Eq)]
enum ScopeState {
    Active,
    Verified,
    Unknown,
}

fn read_scope_state(systemctl: &str, unit: &str, timeout: Duration) -> io::Result<ScopeState> {
    let result = run_host_command(systemctl, &["--user", "is-active", unit], timeout)?;
    let state = result.stdout.trim();
    if matches!(state, "active" | "activating" | "deactivating") {
        return Ok(ScopeState::Active);
    }
    if result.signal.is_some() || !result.stderr.trim().is_empty() {
        return Ok(ScopeState::Unknown);
    }
    if (result.code == Some(3) && state == "inactive")
        || (result.code == Some(4) && matches!(state, "inactive" | "unknown"))
    {
        return Ok(ScopeState::Verified);
    }
    Ok(ScopeState::Unknown)
}

/// Mirrors `verifyScopeCleanup`: a forced kill needs a fresh terminal status.
pub(crate) fn verify_scope_cleanup(systemctl: &str, unit: &str) -> &'static str {
    let attempt = || -> io::Result<&'static str> {
        let state_name = |state: ScopeState| match state {
            ScopeState::Verified => "verified",
            _ => "unknown",
        };
        let initial = read_scope_state(systemctl, unit, Duration::from_secs(5))?;
        if initial != ScopeState::Active {
            return Ok(state_name(initial));
        }
        if signal_scope(systemctl, unit, Signal::Kill).is_err() {
            return Ok("unknown");
        }
        for delay in [20, 50, 100] {
            thread::sleep(Duration::from_millis(delay));
            let state = read_scope_state(systemctl, unit, Duration::from_millis(250))?;
            if state != ScopeState::Active {
                return Ok(state_name(state));
            }
        }
        Ok("failed")
    };
    attempt().unwrap_or("unknown")
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(BASE64[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn signal_str(number: i32) -> Option<&'static str> {
    NixSignal::try_from(number)
        .ok()
        .map(|signal| signal.as_str())
}

fn supervise<'a>(request: &'a Request, input: impl BufRead + Send + 'static) -> Observation<'a> {
    let session = &request.session;
    let limits = &request.limits;
    let started = Instant::now();
    let (tx, rx) = mpsc::channel::<Message>();
    let capture = Arc::new(Mutex::new(Capture::default()));
    let reaped = Arc::new(AtomicBool::new(false));

    spawn_control_reader(
        input,
        session.session_id.clone(),
        session.fencing_token,
        tx.clone(),
    );

    // Every fd the helper holds is close-on-exec; the workload gets fresh pipes
    // and no stdin, so the control channel is not reachable from the scope.
    let spawned = Command::new(&request.command)
        .args(&request.args)
        .env_clear()
        .envs(&request.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn();

    let mut launch_error = None;
    let mut pgid = None;
    match spawned {
        Ok(mut child) => {
            pgid = i32::try_from(child.id()).ok().map(Pid::from_raw);
            let out = spawn_stream_reader(
                child.stdout.take().expect("piped stdout"),
                true,
                capture.clone(),
                limits.output_bytes,
            );
            let err = spawn_stream_reader(
                child.stderr.take().expect("piped stderr"),
                false,
                capture.clone(),
                limits.output_bytes,
            );
            let tx = tx.clone();
            let reaped = reaped.clone();
            thread::spawn(move || {
                let status = child.wait().ok();
                reaped.store(true, Ordering::SeqCst);
                let _ = out.join();
                let _ = err.join();
                let _ = tx.send(Message::Closed(status));
            });
        }
        Err(error) => {
            launch_error = Some(bounded("spawn failed", &error.to_string()));
            let _ = tx.send(Message::Closed(None));
        }
    }

    let mut coordinator = Coordinator::default();
    let mut deadline = Some(started + Duration::from_millis(limits.wall_clock_ms));
    let mut grace: Option<Instant> = None;
    let hard_stop = started
        + Duration::from_millis(limits.wall_clock_ms + limits.termination_grace_ms)
        + HARD_STOP_SLACK;
    let mut status = None;
    let mut termination_error: Option<String> = None;
    let mut protocol_violation = None;
    let mut parent_lost = false;
    let mut abandoned = false;
    let mut trigger = None;
    let mut signal_failed = false;

    while coordinator.phase != Phase::Finished {
        let now = Instant::now();
        let next = [deadline, grace, Some(hard_stop)]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(hard_stop);
        let event = match rx.recv_timeout(next.saturating_duration_since(now)) {
            Ok(Message::Cancel) => Event::Cancel {},
            Ok(Message::Violation(code)) => {
                protocol_violation.get_or_insert(code);
                Event::Cancel {}
            }
            Ok(Message::ParentLost) => {
                parent_lost = true;
                Event::Cancel {}
            }
            Ok(Message::SignalDone {
                signal,
                failed,
                error,
            }) => {
                if let Some(error) = error {
                    termination_error.get_or_insert(error);
                }
                Event::ScopeSignalCompleted { signal, failed }
            }
            Ok(Message::Closed(exit)) => {
                status = exit;
                Event::LauncherClosed {}
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                if now >= hard_stop {
                    abandoned = true;
                    break;
                } else if deadline.is_some_and(|at| now >= at) {
                    deadline = None;
                    Event::DeadlineElapsed {}
                } else if grace.is_some_and(|at| now >= at) {
                    grace = None;
                    Event::GraceElapsed {}
                } else {
                    continue;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                abandoned = true;
                break;
            }
        };
        let Some(effects) = coordinator.advance(event) else {
            continue;
        };
        for effect in effects {
            match effect {
                Effect::SignalScope { signal } => {
                    let tx = tx.clone();
                    let systemctl = request.systemctl_path.clone();
                    let unit = session.unit_name.clone();
                    thread::spawn(move || {
                        let result = signal_scope(&systemctl, &unit, signal);
                        let _ = tx.send(Message::SignalDone {
                            signal,
                            failed: result.is_err(),
                            error: result.err(),
                        });
                    });
                }
                Effect::SignalLauncher { signal } => {
                    if let Some(pgid) = pgid
                        && !reaped.load(Ordering::SeqCst)
                    {
                        // The group may already be gone; scope verification decides.
                        let _ = killpg(pgid, nix_signal(signal));
                    }
                }
                Effect::ArmGrace => {
                    grace =
                        Some(Instant::now() + Duration::from_millis(limits.termination_grace_ms));
                }
                Effect::ClearTimers => {
                    deadline = None;
                    grace = None;
                }
                Effect::Finish {
                    trigger: finished_trigger,
                    signal_failed: failed,
                } => {
                    trigger = finished_trigger;
                    signal_failed = failed;
                }
            }
        }
    }

    if abandoned {
        // Last resort: the launcher never closed. Kill what we can and refuse
        // to claim cleanup; ACS must reconcile the attempt.
        if let Some(pgid) = pgid
            && !reaped.load(Ordering::SeqCst)
        {
            let _ = killpg(pgid, NixSignal::SIGKILL);
        }
        let _ = signal_scope(&request.systemctl_path, &session.unit_name, Signal::Kill);
        termination_error.get_or_insert_with(|| "supervised launcher did not close".to_owned());
        trigger = coordinator.trigger();
    }
    let cleanup = if abandoned {
        "unknown"
    } else {
        verify_scope_cleanup(&request.systemctl_path, &session.unit_name)
    };
    let capture = capture
        .lock()
        .map(|mut capture| std::mem::take(&mut *capture))
        .unwrap_or_default();
    Observation {
        version: VERSION,
        kind: "observation",
        session_id: &session.session_id,
        work_item_id: &session.work_item_id,
        attempt_id: &session.attempt_id,
        lease_id: &session.lease_id,
        worker_id: &session.worker_id,
        fencing_token: session.fencing_token,
        unit_name: &session.unit_name,
        trigger,
        signal_failed,
        termination_error,
        launch_error,
        exit_code: status.and_then(|s| s.code()),
        signal: status.and_then(|s| s.signal()).and_then(signal_str),
        cleanup,
        stdout_bytes: capture.stdout.len(),
        stderr_bytes: capture.stderr.len(),
        stdout: base64(&capture.stdout),
        stderr: base64(&capture.stderr),
        stdout_truncated: capture.stdout_truncated,
        stderr_truncated: capture.stderr_truncated,
        protocol_violation,
        parent_lost,
        abandoned,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    }
}
