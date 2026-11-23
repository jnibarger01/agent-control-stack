//! Prints every record of one kind as JSON lines (`{"id", "item"}` or `{"id", "error", "path"}`), in id order, for
//! the TypeScript parity harness (`scripts/store-parity.ts`). Read-only. Kinds: `work-items`, `attempts`.
use std::path::Path;
use std::process::ExitCode;

use acs_core::attempts::{AttemptError, read_attempt};
use acs_core::store::Store;
use acs_core::work_items::{WorkItemError, read_work_item};
use serde_json::{Value, json};

fn line(id: &str, result: Result<Option<Value>, String>) -> Value {
    match result {
        Ok(Some(item)) => json!({ "id": id, "item": item }),
        Ok(None) => json!({ "id": id, "error": "missing" }),
        Err(path) => json!({ "id": id, "error": "invalid", "path": path }),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [kind, path] = args.as_slice() else {
        eprintln!("usage: acs-store-dump <work-items|attempts> <database>");
        return ExitCode::from(2);
    };
    let store = match Store::open_read_only(Path::new(path)) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
    };
    let ids = match kind.as_str() {
        "work-items" => store.work_item_ids(),
        "attempts" => store.attempt_ids(),
        _ => {
            eprintln!("unknown kind {kind}");
            return ExitCode::from(2);
        }
    };
    let ids = match ids {
        Ok(ids) => ids,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
    };
    for id in ids {
        let result = match kind.as_str() {
            "work-items" => match read_work_item(&store, &id) {
                Err(WorkItemError::Invalid(path)) => Err(path),
                Err(error) => {
                    eprintln!("{error}");
                    return ExitCode::from(1);
                }
                Ok(item) => Ok(item),
            },
            _ => match read_attempt(&store, &id) {
                Err(AttemptError::Invalid(field)) => Err(field.to_owned()),
                Err(error) => {
                    eprintln!("{error}");
                    return ExitCode::from(1);
                }
                Ok(item) => Ok(item),
            },
        };
        println!("{}", line(&id, result));
    }
    ExitCode::SUCCESS
}
