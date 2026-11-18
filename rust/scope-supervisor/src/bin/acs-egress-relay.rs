//! Scoped egress relay for engine isolation (ADR 0014), protocol version 1.
//!
//! A minimal HTTP CONNECT proxy bound to one AF_UNIX socket that is bind-mounted
//! into a `--unshare-net` sandbox, so it is the workload's only route out.
//! ACS sends one start frame on stdin. The relay replies `ready` once listening
//! and then reports each CONNECT decision on stdout. EOF on stdin (ACS closed
//! the relay or was lost) closes the listener and every relayed connection,
//! removes the socket and exits, so egress never outlives its owner.

#![forbid(unsafe_code)]

use std::{
    io::{self, BufRead, Read, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    os::unix::net::{UnixListener, UnixStream},
    path::Path,
    process::ExitCode,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

const VERSION: u8 = 1;
const MAX_START_BYTES: u64 = 16 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_ALLOWLIST: usize = 4;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Destination {
    host: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Start {
    version: u8,
    socket_path: String,
    allowlist: Vec<Destination>,
    connect_timeout_ms: u64,
    header_timeout_ms: u64,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Frame<'a> {
    Ready,
    Decision {
        host: &'a str,
        port: u32,
        allowed: bool,
    },
    Rejected {
        code: &'static str,
    },
    Closed,
}

type Output = Arc<Mutex<Box<dyn Write + Send>>>;

fn emit(output: &Output, frame: &Frame<'_>) {
    if let Ok(mut out) = output.lock() {
        let _ = serde_json::to_writer(&mut *out, frame);
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn read_start(input: &mut impl BufRead) -> Result<Start, &'static str> {
    let mut frame = Vec::new();
    input
        .take(MAX_START_BYTES)
        .read_until(b'\n', &mut frame)
        .map_err(|_| "start_unreadable")?;
    if frame.pop() != Some(b'\n') {
        return Err("start_frame_invalid");
    }
    let start: Start = serde_json::from_slice(&frame).map_err(|_| "start_malformed")?;
    if start.version != VERSION {
        return Err("version_unsupported");
    }
    if !start.socket_path.starts_with('/')
        || start.socket_path.len() > 107
        || start.socket_path.contains('\0')
    {
        return Err("socket_path_invalid");
    }
    if start.allowlist.is_empty()
        || start.allowlist.len() > MAX_ALLOWLIST
        || start
            .allowlist
            .iter()
            .any(|d| !valid_host(&d.host) || d.port == 0)
    {
        return Err("allowlist_invalid");
    }
    if !(1..=60_000).contains(&start.connect_timeout_ms)
        || !(1..=60_000).contains(&start.header_timeout_ms)
    {
        return Err("timeouts_invalid");
    }
    Ok(start)
}

/// Mirrors the TypeScript reference: `CONNECT host:port HTTP/1.x`.
fn parse_target(header: &str) -> Option<(String, u32)> {
    let line = header.split("\r\n").next()?;
    let line = line.strip_suffix('\r').unwrap_or(line);
    // `^CONNECT\s+...\r?$`: no leading or trailing whitespace.
    if line.starts_with(char::is_whitespace) || line.ends_with(char::is_whitespace) {
        return None;
    }
    let mut parts = line.split_whitespace();
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if method != "CONNECT" || parts.next().is_some() {
        return None;
    }
    let minor = version.strip_prefix("HTTP/1.")?;
    if minor.len() != 1 || !minor.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    let (host, port) = target.rsplit_once(':')?;
    if !valid_host(host)
        || port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((host.to_ascii_lowercase(), port.parse().ok()?))
}

struct Tracker {
    closing: AtomicBool,
    sockets: Mutex<Vec<Box<dyn Fn() + Send>>>,
}

impl Tracker {
    fn track(&self, close: Box<dyn Fn() + Send>) -> bool {
        let mut sockets = self.sockets.lock().expect("tracker lock");
        if self.closing.load(Ordering::SeqCst) {
            close();
            return false;
        }
        sockets.push(close);
        true
    }

    fn close_all(&self) {
        self.closing.store(true, Ordering::SeqCst);
        for close in self.sockets.lock().expect("tracker lock").drain(..) {
            close();
        }
    }
}

fn connect(host: &str, port: u16, timeout: Duration) -> io::Result<TcpStream> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "no address");
    for address in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Serves one connection, then closes both ends on every path, like the
/// reference's `end()`/`destroy()`; the tracker only holds clones.
fn handle(client: UnixStream, start: &Start, output: &Output, tracker: &Tracker) {
    let Ok(peer) = client.try_clone() else { return };
    let Ok(closer) = client.try_clone() else {
        return;
    };
    if !tracker.track(Box::new(move || {
        let _ = peer.shutdown(Shutdown::Both);
    })) {
        return;
    }
    let outbound = serve(client, start, output, tracker);
    let _ = closer.shutdown(Shutdown::Both);
    if let Some(outbound) = outbound {
        let _ = outbound.shutdown(Shutdown::Both);
    }
}

fn serve(
    client: UnixStream,
    start: &Start,
    output: &Output,
    tracker: &Tracker,
) -> Option<TcpStream> {
    let deadline = Instant::now() + Duration::from_millis(start.header_timeout_ms);
    let mut client = client;
    let mut header = Vec::new();
    let mut buffer = [0u8; 1024];
    let terminator = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || client.set_read_timeout(Some(remaining)).is_err() {
            return None;
        }
        match client.read(&mut buffer) {
            Ok(0) | Err(_) => return None,
            Ok(n) => header.extend_from_slice(&buffer[..n]),
        }
        if header.len() > MAX_HEADER_BYTES {
            return None;
        }
        if let Some(index) = header.windows(4).position(|w| w == b"\r\n\r\n") {
            break index;
        }
    };
    let _ = client.set_read_timeout(None);
    // latin1 decoding, like the reference.
    let text: String = header[..terminator].iter().map(|&b| b as char).collect();
    let leftover = header[terminator + 4..].to_vec();
    let Some((host, port)) = parse_target(&text) else {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
        return None;
    };
    let allowed = start
        .allowlist
        .iter()
        .any(|d| d.host.eq_ignore_ascii_case(&host) && u32::from(d.port) == port);
    emit(
        output,
        &Frame::Decision {
            host: &host,
            port,
            allowed,
        },
    );
    if !allowed {
        let _ = client.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n");
        return None;
    }
    let outbound = match connect(
        &host,
        port as u16,
        Duration::from_millis(start.connect_timeout_ms),
    ) {
        Ok(stream) => stream,
        Err(_) => {
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n");
            return None;
        }
    };
    let Ok(tracked) = outbound.try_clone() else {
        return None;
    };
    if !tracker.track(Box::new(move || {
        let _ = tracked.shutdown(Shutdown::Both);
    })) {
        return None;
    }
    if client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .is_err()
    {
        return None;
    }
    let closer = outbound.try_clone().ok();
    let mut outbound_writer = outbound;
    if !leftover.is_empty() && outbound_writer.write_all(&leftover).is_err() {
        return None;
    }
    let (Ok(mut outbound_reader), Ok(mut client_writer)) =
        (outbound_writer.try_clone(), client.try_clone())
    else {
        return None;
    };
    let upstream = thread::spawn(move || {
        let _ = io::copy(&mut client, &mut outbound_writer);
        let _ = outbound_writer.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut outbound_reader, &mut client_writer);
    let _ = client_writer.shutdown(Shutdown::Write);
    let _ = upstream.join();
    closer
}

fn run(mut input: impl BufRead + Send + 'static, output: Output) -> Result<(), &'static str> {
    let start = match read_start(&mut input) {
        Ok(start) => Arc::new(start),
        Err(code) => {
            emit(&output, &Frame::Rejected { code });
            return Err(code);
        }
    };
    let path = Path::new(&start.socket_path);
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    let listener = match UnixListener::bind(path) {
        Ok(listener) => listener,
        Err(_) => {
            emit(
                &output,
                &Frame::Rejected {
                    code: "listen_failed",
                },
            );
            return Err("listen_failed");
        }
    };
    emit(&output, &Frame::Ready);

    let tracker = Arc::new(Tracker {
        closing: AtomicBool::new(false),
        sockets: Mutex::new(Vec::new()),
    });
    // Blocking accept: no polling delay on the CONNECT path. Shutdown sets
    // `closing` and wakes the accept with one local connection.
    let acceptor = {
        let (start, output, tracker) = (start.clone(), output.clone(), tracker.clone());
        thread::spawn(move || {
            for client in listener.incoming() {
                if tracker.closing.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(client) = client else {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                };
                let (start, output, tracker) = (start.clone(), output.clone(), tracker.clone());
                thread::spawn(move || handle(client, &start, &output, &tracker));
            }
        })
    };

    // Any further stdin (data or EOF) ends the relay; ACS never sends more frames.
    let mut sink = [0u8; 64];
    let _ = input.read(&mut sink);
    tracker.closing.store(true, Ordering::SeqCst);
    let _ = UnixStream::connect(path);
    let _ = acceptor.join();
    tracker.close_all();
    let _ = std::fs::remove_file(path);
    emit(&output, &Frame::Closed);
    Ok(())
}

fn main() -> ExitCode {
    let output: Output = Arc::new(Mutex::new(Box::new(io::stdout())));
    if std::env::args_os().len() == 1 && run(io::BufReader::new(io::stdin()), output).is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::parse_target;

    #[test]
    fn parses_like_the_reference() {
        assert_eq!(
            parse_target("CONNECT Example.COM:443 HTTP/1.1\r\nHost: x"),
            Some(("example.com".into(), 443))
        );
        assert_eq!(
            parse_target("CONNECT a:99999 HTTP/1.0"),
            Some(("a".into(), 99999))
        );
        for bad in [
            "GET / HTTP/1.1",
            "CONNECT a:443 HTTP/2.0",
            "CONNECT a:443 HTTP/1.12",
            "CONNECT a_b:443 HTTP/1.1",
            "CONNECT a:443 HTTP/1.1 extra",
            "CONNECT a: HTTP/1.1",
            "CONNECT a:123456 HTTP/1.1",
            "CONNECT [::1]:443 HTTP/1.1",
            " CONNECT a:443 HTTP/1.1",
            "CONNECT a:443 HTTP/1.1 ",
        ] {
            assert_eq!(parse_target(bad), None, "{bad}");
        }
    }
}
