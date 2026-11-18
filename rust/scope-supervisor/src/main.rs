#![forbid(unsafe_code)]

mod coordinator;

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

fn main() -> ExitCode {
    if std::env::args_os().len() == 1 && session(io::stdin().lock(), io::stdout().lock()).is_ok() {
        ExitCode::SUCCESS
    } else {
        eprintln!("ACS scope supervisor session did not finish");
        ExitCode::FAILURE
    }
}
