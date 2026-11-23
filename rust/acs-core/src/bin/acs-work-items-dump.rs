//! Prints every work item of a database as one JSON line each (`{"id", "item"}` or `{"id", "error"}`),
//! in id order, for the TypeScript parity harness (`scripts/work-items-parity.ts`). Read-only.
use std::path::Path;
use std::process::ExitCode;

use acs_core::store::Store;
use acs_core::work_items::{WorkItemError, read_work_item};
use serde_json::json;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: acs-work-items-dump <database>");
        return ExitCode::from(2);
    };
    let store = match Store::open_read_only(Path::new(&path)) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
    };
    let ids = match store.work_item_ids() {
        Ok(ids) => ids,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
    };
    for id in ids {
        let line = match read_work_item(&store, &id) {
            Ok(Some(item)) => json!({ "id": id, "item": item }),
            Ok(None) => json!({ "id": id, "error": "missing" }),
            Err(WorkItemError::Invalid(path)) => {
                json!({ "id": id, "error": "invalid", "path": path })
            }
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::from(1);
            }
        };
        println!("{line}");
    }
    ExitCode::SUCCESS
}
