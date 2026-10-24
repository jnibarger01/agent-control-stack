# Jace Commander: home read / projects write — DRAFT

## Approved intent

- Allow **ordinary managed filesystem reads** inside the canonical home directory (`/home/jacen`), including projects.
- Deny filesystem reads **outside home** through JC's managed filesystem tools.
- Restrict **all Git tools** (even reads that may refresh metadata) and JC filesystem writes to `/home/jacen/projects`, with existing ACS authorization/approval.
- Keep credential and service-state directories inaccessible. Preserve canonical path and symlink checks.
- Importing a text file can use distinct `read_file` and `write_file` authorizations; this is **not** a general binary-safe copy operation. The `move_file` tool changes the source and is not an import.

## Proposed configuration — NOT ACTIVE

ACS gateway:

```dotenv
ACS_JACE_COMMANDER_ALLOWED_ROOTS=/home/jacen
ACS_JACE_COMMANDER_WRITE_ROOTS=/home/jacen/projects
```

Jace Commander bridge/executor:

```dotenv
JC_FS_ROOTS=/home/jacen
JC_FS_WRITE_ROOTS=/home/jacen/projects
```

Retain existing `*_DENIED_ROOTS` values and system-level restricted paths. Write roots must lie inside the read roots. Setting the optional write-root variable enables split-root enforcement; leaving it unset retains legacy single-root behavior. Do not update running services with the above configuration until release gates pass.

## Release blockers — no deployment or merge yet

- [ ] Run the new ACS and JC regression tests and TypeScript build against this exact commit in CI.
- [ ] Audit every independent executor, including Desktop Commander, Herdr agent tools and local Jace Commander policy paths. A JC-only filesystem setting is not a host-wide sandbox.
- [ ] Review unrestricted command and privileged execution. In split mode `start_process` and `privileged_exec` intentionally refuse execution; implement OS-enforced write confinement before re-enabling them.
- [ ] Implement a native, audited, atomic, no-overwrite `copy_file` primitive if binary/general home-to-project import is required. Keep sources intact and recheck symlinks/inodes against TOCTOU attacks.
- [ ] Inspect the active unit EnvironmentFile precedence and perform allow/deny smoke tests using isolated files and a nonproduction identity.

This PR changes repository code and examples only. It does **not** change any active service, credential, or environment file.
