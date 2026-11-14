# JC Kernel Witness V2 — Production Enablement & Operations Runbook

## 1. Architecture & Privilege Separation

JC Kernel Witness V2 provides independently verified, kernel-observed runtime provenance across **process**, **filesystem**, and **network** activity (`jc.kernel-witness.receipt.v2`) with privilege-separated Ed25519 signing and append-only WORM evidence anchoring.

### Service Identities & Least-Privilege Boundaries

| Identity | Systemd Unit | Linux Capabilities | Owned Paths | Security Boundary |
|---|---|---|---|---|
| `jc-witness-signer` | `jc-witness-signerd.service` | **None** (`CapabilityBoundingSet=`) | `/var/lib/jace-commander/witness-signer` (`0700`), `/run/jc-witness-signer/sign.sock` (`0660`) | Holds the Ed25519 private signing key (`0400`). PrivateNetwork=yes. Authenticates `jc-kernel-witness` via `SO_PEERCRED` (`uid != signer_uid`) and `/proc/<pid>/exe` attestation. Validates receipt structure, freshness, invocation uniqueness, and hash chain before signing. |
| `acs-jc` | `acs-jc-bridge.service` | `CAP_BPF`, `CAP_PERFMON`, `CAP_SYS_RESOURCE` (with `Delegate=yes` cgroup v2) | `/var/lib/acs-jc` (`0700`), `/run/jace-commander/witness` (`0750`) | Spawns `jc-kernel-witness` outside the Bubblewrap sandbox (`clone3(CLONE_INTO_CGROUP)`), while untrusted agent workloads execute inside `bwrap --cap-drop ALL` with `/run/jc-witness-signer` and `/var/lib/jace-commander/witness-signer` masked. |
| `acs-core` | `acs-core.service` | **None** (`CapabilityBoundingSet=`) | `/var/lib/acs-core` (`0700`), `/var/lib/acs-core/worm-vault` (`0700`) | Verifies Ed25519 signatures, domain-separated digests, observer key lifecycle (`active`/`rotated`/`retired`/`revoked`), and ACS lease correlation; commits atomically to SQLite and replicates to the WORM evidence sink. |

## 2. Dry-Run Validation & Installation

Always run the installer in `--dry-run` mode first to validate kernel BTF (`/sys/kernel/btf/vmlinux`), unified cgroup v2 hierarchy, `bwrap`, and CO-RE eBPF object relocation without mutating host state:

```bash
./ops/jc-kernel-witness/install-kernel-witness.sh --dry-run
```

For staging into an isolated root directory (e.g., inside a disposable VM or package build root):

```bash
./ops/jc-kernel-witness/install-kernel-witness.sh --prefix /tmp/staging-root --skip-useradd --skip-systemd
```

## 3. Key Provisioning, Rotation, Retirement, and Revocation

- **Register initial key**:
  ```bash
  /usr/lib/jace-commander/jc-kernel-witness key-admin register \
    --state-dir /var/lib/jace-commander/witness-signer \
    --observer-id jc-witness-prod-1
  ```
- **Rotate key**:
  ```bash
  ./ops/jc-kernel-witness/upgrade-kernel-witness.sh --rotate-key --old-key-id <old-id> --new-key-id <new-id>
  ```
- **Retire a rotated key** (preserves historical verification before `rotatedAt` while disabling future use):
  ```bash
  /usr/lib/jace-commander/jc-kernel-witness key-admin retire \
    --state-dir /var/lib/jace-commander/witness-signer \
    --key-id <old-id>
  ```
- **Emergency revocation**:
  ```bash
  /usr/lib/jace-commander/jc-kernel-witness key-admin revoke \
    --state-dir /var/lib/jace-commander/witness-signer \
    --key-id <compromised-id> \
    --reason "key_compromise_drill"
  ```

## 4. Rollback & Uninstall

- **Atomic Rollback** (restores `.prev` binaries and SHA-256 manifest while preserving all durable SQLite and WORM evidence):
  ```bash
  ./ops/jc-kernel-witness/rollback-kernel-witness.sh
  ```
- **Uninstall** (removes binaries and units while preserving `/var/lib/acs-core` and WORM vault unless `--purge-state` is specified):
  ```bash
  ./ops/jc-kernel-witness/uninstall-kernel-witness.sh
  ```

## 5. Disposable QEMU/KVM Adversarial Acceptance Suite

To run the full 22-scenario live-kernel eBPF + privilege-separated signer + WORM + LoopTrace acceptance suite inside an isolated QEMU/KVM guest VM (without attaching any eBPF programs to the live host kernel):

```bash
./ops/jc-kernel-witness/vm-adversarial-acceptance.sh
```
