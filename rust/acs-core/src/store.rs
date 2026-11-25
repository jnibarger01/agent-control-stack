//! Read-only access to an ACS SQLite database. This module contains no write path.
//!
//! The connection is opened with `SQLITE_OPEN_READ_ONLY` and then `PRAGMA query_only = ON`. The
//! only statement this module prepares is a single `SELECT` over `audit_events`. A test in
//! `tests/read_only.rs` checks the source for write SQL.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    /// An immutable open was requested while a non-empty `-wal` exists.
    UncheckpointedWal,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "sqlite: {error}"),
            Self::UncheckpointedWal => f.write_str("non-empty write-ahead log present"),
        }
    }
}

/// Percent-encodes the characters that are special in a SQLite `file:` URI path.
fn percent_encode_path(path: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'%' | b'?' | b'#' | b' ' => out.extend(format!("%{byte:02X}").bytes()),
            _ => out.push(byte),
        }
    }
    // Multi-byte UTF-8 sequences are copied byte for byte, so the result stays valid UTF-8.
    String::from_utf8_lossy(&out).into_owned()
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// One `audit_events` row, exactly as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRow {
    pub sequence: i64,
    pub id: String,
    pub name: String,
    pub time_unix_nano: String,
    pub attributes: String,
    pub body: String,
    pub previous_hash: String,
    pub event_hash: String,
}

pub struct Store {
    connection: Connection,
}

impl Store {
    /// Opens an existing database read-only with `SQLITE_OPEN_READ_ONLY`. Does not create the main
    /// file. SQLite may create an empty `-wal` and a `-shm` beside a WAL-mode database on first
    /// open, which is a filesystem write. Use `open_immutable` for archives where that is unacceptable.
    pub fn open_read_only(path: &Path) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.pragma_update(None, "query_only", true)?;
        Ok(Self { connection })
    }

    /// Opens a copy or archive with `immutable=1`. SQLite then creates no `-wal` and no `-shm`,
    /// takes no locks, and reads the main file as it is.
    ///
    /// Refused when a non-empty `-wal` exists. Its committed frames would be silently ignored.
    /// Only use this for files that no other process can write. Live databases use `open_read_only`.
    pub fn open_immutable(path: &Path) -> Result<Self, StoreError> {
        let wal = {
            let mut name = path.as_os_str().to_owned();
            name.push("-wal");
            std::path::PathBuf::from(name)
        };
        if std::fs::metadata(&wal).is_ok_and(|meta| meta.len() > 0) {
            return Err(StoreError::UncheckpointedWal);
        }
        let uri = format!(
            "file:{}?immutable=1",
            percent_encode_path(&path.to_string_lossy())
        );
        let connection = Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.pragma_update(None, "query_only", true)?;
        Ok(Self { connection })
    }

    /// All audit rows in ascending sequence order, matching `readAuditChainEvents` in TypeScript.
    pub fn audit_rows(&self) -> Result<Vec<AuditRow>, StoreError> {
        self.audit_rows_after(i64::MIN)
    }

    /// Audit rows with `sequence > after`, in ascending sequence order.
    pub fn audit_rows_after(&self, after: i64) -> Result<Vec<AuditRow>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT sequence, id, name, time_unix_nano, attributes, body, previous_hash, event_hash \
             FROM audit_events WHERE sequence > ?1 ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([after], |row| {
            Ok(AuditRow {
                sequence: row.get(0)?,
                id: row.get(1)?,
                name: row.get(2)?,
                time_unix_nano: row.get(3)?,
                attributes: row.get(4)?,
                body: row.get(5)?,
                previous_hash: row.get(6)?,
                event_hash: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The number of audit rows with `sequence <= through`, and the stored hash at `through`.
    pub fn audit_prefix(&self, through: i64) -> Result<(i64, Option<String>), StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT (SELECT COUNT(*) FROM audit_events WHERE sequence <= ?1), \
                    (SELECT event_hash FROM audit_events WHERE sequence = ?1)",
        )?;
        Ok(statement.query_row([through], |row| Ok((row.get(0)?, row.get(1)?)))?)
    }
}
