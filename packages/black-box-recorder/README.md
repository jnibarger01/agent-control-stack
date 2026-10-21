# Agent Black Box Recorder

In-memory evidence recorder for ACS. It answers what was asked, what was authorized, what ran, and what is missing. It does not authorize, approve, issue capabilities, or dispatch work.

Default is off. Set `ABBR_ENABLED=1` for library callers, and `VITE_ABBR_ENABLED=1` before building Mission Control Web to show the Black Box page. With the flag unset, the eleven Mission Control destinations are unchanged.

This copy is the recorder core plus a redacted snapshot and labeled fixtures. It is not wired into the gateway write path and it does not migrate the ACS database. Looptrace remains the existing correlated-trace query package. This package does not replace it.

The snapshot under `src/snapshot.json` is a point-in-time redacted read, not a live socket. Fixture runs are nonproduction and labeled as such.
