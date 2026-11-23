#![forbid(unsafe_code)]

mod coordinator;
mod supervise;

use std::{
    io::{self, BufRead, Read, Write},
    process::ExitCode,
};

use coordinator::{Coordinator, Effect, Event, Phase};
use serde::{Deserialize, Serialize};

const VERSION: u8 = 1;
const MAX_FRAME_BYTES: u64 = 1024;
const MAX_EVENTS: u32 = 16;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    seq: u32,
    event: Event,
}

#[derive(Serialize)]
struct Reply {
    version: u8,
    seq: u32,
    effects: Vec<Effect>,
}

fn protocol_error() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "supervisor protocol error")
}

fn session(mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let mut coordinator = Coordinator::default();
    let mut frame = Vec::new();
    for seq in 1..=MAX_EVENTS {
        frame.clear();
        (&mut input)
            .take(MAX_FRAME_BYTES)
            .read_until(b'\n', &mut frame)?;
        if frame.pop() != Some(b'\n') {
            return Err(protocol_error());
        }
        let request: Request = serde_json::from_slice(&frame).map_err(|_| protocol_error())?;
        if request.version != VERSION || request.seq != seq {
            return Err(protocol_error());
        }
        let effects = coordinator
            .advance(request.event)
            .ok_or_else(protocol_error)?;
        let reply = Reply {
            version: VERSION,
            seq,
            effects,
        };
        serde_json::to_writer(&mut output, &reply)?;
        output.write_all(b"\n")?;
        output.flush()?;
        if coordinator.phase == Phase::Finished {
            return Ok(());
        }
    }
    Err(protocol_error())
}

/// Marks every descriptor inherited from the parent, other than stdin, stdout and stderr, close-on-exec.
///
/// Descriptors this process opens are already close-on-exec, but ones the parent left open without the flag would
/// otherwise reach every workload and host probe this helper spawns (seen on CI runners). The helper communicates only
/// over stdin and stdout, so it needs none of them after exec. Runs before any thread or child exists.
fn seal_inherited_descriptors() {
    use nix::fcntl::{FcntlArg, FdFlag, fcntl};
    let Ok(entries) = std::fs::read_dir("/proc/self/fd") else {
        return;
    };
    let descriptors: Vec<i32> = entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .filter(|&fd| fd > 2)
        .collect();
    for fd in descriptors {
        // The directory handle used for the listing is already closed or close-on-exec; errors are ignored.
        let _ = fcntl(fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC));
    }
}

fn main() -> ExitCode {
    seal_inherited_descriptors();
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = match args.as_slice() {
        // Protocol v1: termination decisions only, used by the parity harness.
        [] => session(io::stdin().lock(), io::stdout().lock()),
        // Protocol v2: one live, attempt-bound supervised scope.
        [mode] if mode == "supervise" => {
            supervise::run(io::BufReader::new(io::stdin()), io::stdout().lock())
        }
        _ => Err(protocol_error()),
    };
    if result.is_ok() {
        ExitCode::SUCCESS
    } else {
        eprintln!("ACS scope supervisor session did not finish");
        ExitCode::FAILURE
    }
}
