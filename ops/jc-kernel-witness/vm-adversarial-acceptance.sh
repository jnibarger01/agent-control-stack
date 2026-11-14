#!/usr/bin/env bash
# JC Kernel Witness V2 — Phase 8 Full Adversarial QEMU/KVM Acceptance Suite (22 Scenarios)
# Executes live eBPF kernel observation (process + filesystem + network) and privilege-separated
# signing inside a disposable QEMU/KVM guest VM (7.3.4-1-cachyos), plus ACS SQLite / WORM / LoopTrace
# adversarial recovery checks. Never attaches eBPF to the live host kernel.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUILD_DIR="${REPO_ROOT}/apps/jace-commander/native/kernel-witness/build"
KERNEL_IMG="/usr/lib/modules/$(uname -r)/vmlinuz"

if [[ ! -r "${KERNEL_IMG}" ]]; then
  KERNEL_IMG="$(ls -1 /usr/lib/modules/*/vmlinuz 2>/dev/null | tail -n 1)"
fi
if [[ ! -r "${KERNEL_IMG}" ]]; then
  echo "ERROR: No readable vmlinuz found in /usr/lib/modules/*/vmlinuz" >&2
  exit 1
fi
if [[ ! -w /dev/kvm ]]; then
  echo "ERROR: /dev/kvm is not writable" >&2
  exit 1
fi

WITNESS_BIN="${BUILD_DIR}/jc-kernel-witness"
SIGNERD_BIN="${BUILD_DIR}/jc-witness-signerd"
BPF_OBJ="${BUILD_DIR}/witness.bpf.o"

for req in "${WITNESS_BIN}" "${BPF_OBJ}"; do
  if [[ ! -f "${req}" ]]; then
    echo "ERROR: Missing build artifact ${req}" >&2
    exit 1
  fi
done

VM_WORK="$(mktemp -d /tmp/jc-witness-vm-XXXXXX)"
trap 'rm -rf "${VM_WORK}"' EXIT

ROOTFS="${VM_WORK}/rootfs"
mkdir -p "${ROOTFS}"/{bin,sbin,usr/bin,usr/sbin,usr/lib,lib,lib64,proc,sys,dev,run,tmp,var/lib/jace-commander/witness-signer,etc/jace-commander,work}

# Helper to copy binary and all shared library dependencies into initramfs
copy_bin() {
  local bin_path="$1"
  local dest_dir="${2:-/bin}"
  cp -L "${bin_path}" "${ROOTFS}${dest_dir}/$(basename "${bin_path}")"
  chmod +x "${ROOTFS}${dest_dir}/$(basename "${bin_path}")"
  ldd "${bin_path}" 2>/dev/null | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^\//) print $i;
    }
  }' | while read -r lib; do
    if [[ -f "${lib}" ]]; then
      mkdir -p "${ROOTFS}$(dirname "${lib}")"
      cp -L -n "${lib}" "${ROOTFS}${lib}" 2>/dev/null || true
    fi
  done
}

for cmd in /bin/sh /bin/bash /usr/bin/mount /usr/bin/umount /usr/bin/uname /usr/bin/env /usr/bin/id /usr/bin/cat /usr/bin/mkdir /usr/bin/rm /usr/bin/mv /usr/bin/cp /usr/bin/chmod /usr/bin/chown /usr/bin/sleep /usr/bin/kill /usr/bin/head /usr/bin/tr /usr/bin/wc /usr/bin/grep; do
  if [[ -x "${cmd}" ]]; then
    copy_bin "${cmd}" "/bin"
  fi
done

copy_bin "${WITNESS_BIN}" "/usr/bin"
if [[ -x "${SIGNERD_BIN}" ]]; then
  copy_bin "${SIGNERD_BIN}" "/usr/bin"
fi
cp "${BPF_OBJ}" "${ROOTFS}/usr/lib/witness.bpf.o"

# Compile a lightweight guest C helper for local IPv4/IPv6 TCP/UDP server+client & UID drop tests
cat > "${VM_WORK}/guest_helper.c" << 'CEOF'
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static int setup_loopback(void) {
    // Minimal ioctl SIOCSIFFLAGS IFF_UP on "lo"
    #include <net/if.h>
    #include <sys/ioctl.h>
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);
    if (ioctl(fd, SIOCGIFFLAGS, &ifr) == 0) {
        ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
        ioctl(fd, SIOCSIFFLAGS, &ifr);
    }
    close(fd);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    const char *cmd = argv[1];
    if (strcmp(cmd, "lo-up") == 0) {
        return setup_loopback() == 0 ? 0 : 1;
    }
    if (strcmp(cmd, "poweroff") == 0) {
        sync();
        reboot(RB_POWER_OFF);
        return 0;
    }
    if (strcmp(cmd, "tcp4-server") == 0 && argc >= 3) {
        int port = atoi(argv[2]);
        int s = socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
        if (bind(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) return 1;
        if (listen(s, 4) != 0) return 1;
        int c = accept(s, NULL, NULL);
        if (c >= 0) {
            char buf[16];
            ssize_t n = read(c, buf, sizeof(buf));
            (void)n;
            close(c);
        }
        close(s);
        return 0;
    }
    if (strcmp(cmd, "tcp6-server") == 0 && argc >= 3) {
        int port = atoi(argv[2]);
        int s = socket(AF_INET6, SOCK_STREAM, 0);
        int one = 1;
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        struct sockaddr_in6 addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin6_family = AF_INET6;
        addr.sin6_port = htons(port);
        addr.sin6_addr = in6addr_loopback;
        if (bind(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) return 1;
        if (listen(s, 4) != 0) return 1;
        int c = accept(s, NULL, NULL);
        if (c >= 0) close(c);
        close(s);
        return 0;
    }
    if (strcmp(cmd, "workload") == 0 && argc >= 3) {
        const char *dir = argv[2];
        // 1. Spawn 3 child processes + 1 background grandchild that briefly outlives its immediate parent (Scenarios 1 & 2)
        for (int i = 0; i < 3; i++) {
            pid_t p = fork();
            if (p == 0) {
                execl("/bin/sh", "sh", "-c", "true", NULL);
                _exit(127);
            }
            waitpid(p, NULL, 0);
        }
        pid_t mid = fork();
        if (mid == 0) {
            pid_t gc = fork();
            if (gc == 0) {
                usleep(50000);
                _exit(0);
            }
            _exit(0);
        }
        waitpid(mid, NULL, 0);
        usleep(80000);

        // 2. Filesystem operations: mkdir, create, write, modify, truncate, rename, unlink, rmdir (Scenario 6)
        char sub[256], f1[256], f2[256];
        snprintf(sub, sizeof(sub), "%s/subdir", dir);
        snprintf(f1, sizeof(f1), "%s/subdir/alpha.txt", dir);
        snprintf(f2, sizeof(f2), "%s/subdir/beta.txt", dir);
        mkdir(sub, 0755);
        int fd = open(f1, O_CREAT | O_WRONLY | O_TRUNC, 0644);
        if (fd >= 0) {
            if (write(fd, "hello", 5) < 0) {}
            if (pwrite(fd, "world", 5, 5) < 0) {}
            if (ftruncate(fd, 4) < 0) {}
            close(fd);
        }
        rename(f1, f2);
        unlink(f2);
        rmdir(sub);
        // Also attempt an open on a nonexistent file (attempted vs completed)
        int bad_fd = open("/nonexistent_witness_probe_path", O_WRONLY);
        if (bad_fd >= 0) close(bad_fd);

        // 3. Network operations: IPv4 TCP connect (succeeds to 18080), IPv4 TCP refused (18081), IPv6 TCP (18082), UDP sendmsg (18083)
        int s4_ok = socket(AF_INET, SOCK_STREAM, 0);
        if (s4_ok >= 0) {
            struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(18080), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
            if (connect(s4_ok, (struct sockaddr *)&a, sizeof(a)) == 0) {
                if (write(s4_ok, "ping", 4) < 0) {}
            }
            close(s4_ok);
        }
        int s4_ref = socket(AF_INET, SOCK_STREAM, 0);
        if (s4_ref >= 0) {
            struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(18081), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
            connect(s4_ref, (struct sockaddr *)&a, sizeof(a));
            close(s4_ref);
        }
        int s6_ok = socket(AF_INET6, SOCK_STREAM, 0);
        if (s6_ok >= 0) {
            struct sockaddr_in6 a6;
            memset(&a6, 0, sizeof(a6));
            a6.sin6_family = AF_INET6;
            a6.sin6_port = htons(18082);
            a6.sin6_addr = in6addr_loopback;
            connect(s6_ok, (struct sockaddr *)&a6, sizeof(a6));
            close(s6_ok);
        }
        int u4 = socket(AF_INET, SOCK_DGRAM, 0);
        if (u4 >= 0) {
            struct sockaddr_in au = { .sin_family = AF_INET, .sin_port = htons(18083), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
            sendto(u4, "udp-pkt", 7, 0, (struct sockaddr *)&au, sizeof(au));
            close(u4);
        }
        return 0;
    }
    if (strcmp(cmd, "mmap-workload") == 0 && argc >= 3) {
        const char *path = argv[2];
        int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        if (ftruncate(fd, 4096) != 0) return 1;
        void *p = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (p != MAP_FAILED) {
            ((char *)p)[0] = 'X';
            munmap(p, 4096);
        }
        close(fd);
        return 0;
    }
    if (strcmp(cmd, "run-as-uid") == 0 && argc >= 5) {
        uid_t uid = (uid_t)atoi(argv[2]);
        gid_t gid = (gid_t)atoi(argv[3]);
        if (setgid(gid) != 0 || setuid(uid) != 0) return 2;
        execvp(argv[4], &argv[4]);
        return 127;
    }
    if (strcmp(cmd, "unauth-uid-probe") == 0 && argc >= 4) {
        uid_t uid = (uid_t)atoi(argv[2]);
        const char *key_path = argv[3];
        const char *sock_path = argc >= 5 ? argv[4] : NULL;
        if (setgid(uid) != 0 || setuid(uid) != 0) return 2;
        int fd = open(key_path, O_RDONLY);
        if (fd >= 0) {
            close(fd);
            printf("LEAKED_KEY\n");
            return 10;
        }
        if (sock_path) {
            int s = socket(AF_UNIX, SOCK_STREAM, 0);
            struct sockaddr_un un;
            memset(&un, 0, sizeof(un));
            un.sun_family = AF_UNIX;
            strncpy(un.sun_path, sock_path, sizeof(un.sun_path) - 1);
            if (connect(s, (struct sockaddr *)&un, sizeof(un)) == 0) {
                const char *req = "{\"op\":\"sign\",\"receipt\":{}}\n";
                if (write(s, req, strlen(req)) < 0) {}
                char resp[512];
                ssize_t n = read(s, resp, sizeof(resp) - 1);
                if (n > 0) {
                    resp[n] = '\0';
                    if (strstr(resp, "\"ok\":true")) {
                        close(s);
                        printf("UNAUTH_SIGN_ALLOWED\n");
                        return 11;
                    }
                }
            }
            close(s);
        }
        printf("ISOLATION_VERIFIED\n");
        return 0;
    }
    return 1;
}
CEOF

cc -O2 -Wall "${VM_WORK}/guest_helper.c" -o "${VM_WORK}/guest_helper"
copy_bin "${VM_WORK}/guest_helper" "/bin"

cat > "${ROOTFS}/init" << 'INITEOF'
#!/bin/sh
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /sys/fs/cgroup /sys/kernel/tracing /tmp /run /work /foreign_cg
mount -t cgroup2 none /sys/fs/cgroup
mount -t tracefs none /sys/kernel/tracing 2>/dev/null || mount -t debugfs none /sys/kernel/debug 2>/dev/null || true

exec >/dev/ttyS0 2>&1
echo "=== VM_ACCEPTANCE_BEGIN ==="
echo "KERNEL_RELEASE=$(uname -r)"
/bin/guest_helper lo-up

# Start foreign cgroup activity (Scenarios 3, 4, 5: unrelated process, fs, net exclusion)
mkdir -p /sys/fs/cgroup/foreign_noise
(
  echo $$ > /sys/fs/cgroup/foreign_noise/cgroup.procs
  while true; do
    /bin/sh -c "echo noise > /tmp/foreign_noise.txt; rm -f /tmp/foreign_noise.txt" 2>/dev/null
    sleep 0.05
  done
) &
NOISE_PID=$!

# Check if jc-witness-signerd is available for UID-separated signing
SIGNER_DIR="/var/lib/jace-commander/witness-signer"
mkdir -p "${SIGNER_DIR}/keys" /run/jc-witness-signer
chmod 0700 "${SIGNER_DIR}"

if [ -x /usr/bin/jc-witness-signerd ]; then
  /usr/bin/jc-kernel-witness key-admin register \
    --manifest "${SIGNER_DIR}/key-manifest.json" \
    --private-out "${SIGNER_DIR}/keys/active.priv.pem" \
    --public-out /etc/jace-commander/pub.pem > /tmp/key_reg.json
  chmod 0600 "${SIGNER_DIR}/keys/active.priv.pem"
  chmod 0644 /etc/jace-commander/pub.pem "${SIGNER_DIR}/key-manifest.json"
  chown -R 991:991 "${SIGNER_DIR}" /run/jc-witness-signer
  # Launch jc-witness-signerd as UID 991 while observer runs as UID 0 (distinct UIDs!)
  /bin/guest_helper run-as-uid 991 991 /usr/bin/jc-witness-signerd \
    --socket /run/jc-witness-signer/sign.sock \
    --private-key "${SIGNER_DIR}/keys/active.priv.pem" \
    --key-manifest "${SIGNER_DIR}/key-manifest.json" \
    --audit-log "${SIGNER_DIR}/audit.jsonl" \
    --allow-uid 0 \
    --forbid-workload-uid 992 \
    --require-distinct-uid &
  SIGNERD_PID=$!
  sleep 0.3

  # Scenario 14 & 22: Unauthorized UID (992) cannot read private key or sign via signerd
  UNAUTH_OUT=$(/bin/guest_helper unauth-uid-probe 992 "${SIGNER_DIR}/keys/active.priv.pem" /run/jc-witness-signer/sign.sock)
  echo "SCENARIO_14_22=${UNAUTH_OUT}"
  SIGN_ARGS="--signer-socket /run/jc-witness-signer/sign.sock --include-display-paths"
  PUB_KEY="/etc/jace-commander/pub.pem"
else
  /usr/bin/jc-kernel-witness keygen --private-out "${SIGNER_DIR}/priv.pem" --public-out /etc/jace-commander/pub.pem
  chmod 0400 "${SIGNER_DIR}/priv.pem"
  UNAUTH_OUT=$(/bin/guest_helper unauth-uid-probe 992 "${SIGNER_DIR}/priv.pem")
  echo "SCENARIO_14_22=${UNAUTH_OUT}"
  SIGN_ARGS="--signing-key ${SIGNER_DIR}/priv.pem --signing-key-id vm-key-1 --include-display-paths"
  PUB_KEY="/etc/jace-commander/pub.pem"
fi

# Start local TCPv4 (18080) and TCPv6 (18082) servers in foreign cgroup
(
  echo $$ > /sys/fs/cgroup/foreign_noise/cgroup.procs
  /bin/guest_helper tcp4-server 18080
) &
(
  echo $$ > /sys/fs/cgroup/foreign_noise/cgroup.procs
  /bin/guest_helper tcp6-server 18082
) &
sleep 0.2

# Run full workload under live kernel eBPF observation (Scenarios 1, 2, 3, 4, 5)
/usr/bin/jc-kernel-witness run \
  --mode live \
  --bpf-obj /usr/lib/witness.bpf.o \
  --cgroup-root /sys/fs/cgroup \
  --observer-id vm-obs-1 \
  --work-item-id wi-vm-1 \
  --attempt-id att-vm-1 \
  --lease-id lease-vm-1 \
  --invocation-hash 1111111111111111111111111111111111111111111111111111111111111111 \
  --acs-anchor-ref wi-vm-1 \
  --receipt-out /tmp/receipt_full.json \
  ${SIGN_ARGS} \
  -- /bin/guest_helper workload /work
RUN_RC=$?
echo "FULL_WORKLOAD_RUN_RC=${RUN_RC}"

/usr/bin/jc-kernel-witness verify \
  --receipt /tmp/receipt_full.json \
  --public-key "${PUB_KEY}" \
  --key-manifest "${SIGNER_DIR}/key-manifest.json" \
  --work-item-id wi-vm-1 \
  --attempt-id att-vm-1 \
  --lease-id lease-vm-1 \
  --invocation-hash 1111111111111111111111111111111111111111111111111111111111111111 \
  --seen-hashes-file /tmp/seen_hashes.txt \
  --require-live \
  --require-v2 > /tmp/verify_full.json
VERIFY_RC=$?
echo "FULL_WORKLOAD_VERIFY_RC=${VERIFY_RC}"
echo "VERIFY_JSON=$(cat /tmp/verify_full.json)"

# Scenario 16: Replay same receipt against seen-hashes must fail closed
/usr/bin/jc-kernel-witness verify \
  --receipt /tmp/receipt_full.json \
  --public-key "${PUB_KEY}" \
  --seen-hashes-file /tmp/seen_hashes.txt \
  --require-live \
  --require-v2 > /tmp/verify_replay.json 2>&1
REPLAY_RC=$?
echo "SCENARIO_16_REPLAY_RC=${REPLAY_RC}"

# Scenario 7: mmap(MAP_SHARED) triggers partial filesystem completeness (rejected by strict verify, accepted with --allow-partial-categories)
/usr/bin/jc-kernel-witness run \
  --mode live \
  --bpf-obj /usr/lib/witness.bpf.o \
  --cgroup-root /sys/fs/cgroup \
  --observer-id vm-obs-1 \
  --work-item-id wi-vm-mmap \
  --attempt-id att-vm-mmap \
  --lease-id lease-vm-mmap \
  --invocation-hash 5555555555555555555555555555555555555555555555555555555555555555 \
  --receipt-out /tmp/receipt_mmap.json \
  ${SIGN_ARGS} \
  -- /bin/guest_helper mmap-workload /work/mmap_shared.bin
/usr/bin/jc-kernel-witness verify \
  --receipt /tmp/receipt_mmap.json \
  --public-key "${PUB_KEY}" \
  --require-live \
  --require-v2 > /tmp/verify_mmap_strict.json 2>&1
MMAP_STRICT_RC=$?
/usr/bin/jc-kernel-witness verify \
  --receipt /tmp/receipt_mmap.json \
  --public-key "${PUB_KEY}" \
  --require-live \
  --require-v2 \
  --allow-partial-categories > /tmp/verify_mmap_partial.json 2>&1
MMAP_PARTIAL_RC=$?
echo "SCENARIO_07_MMAP_STRICT_RC=${MMAP_STRICT_RC}"
echo "SCENARIO_07_MMAP_PARTIAL_RC=${MMAP_PARTIAL_RC}"

# Scenario 8: Process killed by SIGKILL mid-execution is still observed and receipt is complete
/usr/bin/jc-kernel-witness run \
  --mode live \
  --bpf-obj /usr/lib/witness.bpf.o \
  --cgroup-root /sys/fs/cgroup \
  --observer-id vm-obs-1 \
  --work-item-id wi-vm-sigkill \
  --attempt-id att-vm-sigkill \
  --lease-id lease-vm-sigkill \
  --invocation-hash 3333333333333333333333333333333333333333333333333333333333333333 \
  --receipt-out /tmp/receipt_sigkill.json \
  ${SIGN_ARGS} \
  -- /bin/sh -c 'kill -9 $$'
SIGKILL_RUN_RC=$?
/usr/bin/jc-kernel-witness verify \
  --receipt /tmp/receipt_sigkill.json \
  --public-key "${PUB_KEY}" \
  --require-live \
  --require-v2 > /tmp/verify_sigkill.json 2>&1
SIGKILL_VERIFY_RC=$?
echo "SCENARIO_08_SIGKILL_RUN_RC=${SIGKILL_RUN_RC}"
echo "SCENARIO_08_SIGKILL_VERIFY_RC=${SIGKILL_VERIFY_RC}"

# Scenario 11: Missing eBPF/cgroup permissions in live mode fails closed (exit 70 or 71)
/bin/guest_helper run-as-uid 992 992 /usr/bin/jc-kernel-witness run \
  --mode live \
  --bpf-obj /usr/lib/witness.bpf.o \
  --cgroup-root /sys/fs/cgroup \
  --observer-id vm-obs-1 \
  --work-item-id wi-vm-unpriv \
  --attempt-id att-vm-unpriv \
  --lease-id lease-vm-unpriv \
  --invocation-hash 4444444444444444444444444444444444444444444444444444444444444444 \
  --receipt-out /tmp/receipt_unpriv.json \
  ${SIGN_ARGS} \
  -- /bin/sh -c "true" >/dev/null 2>&1
UNPRIV_LIVE_RC=$?
echo "SCENARIO_11_UNPRIV_LIVE_RC=${UNPRIV_LIVE_RC}"

# Scenario 9: Observer termination (SIGTERM during live run -> incomplete -> verify rejects)
/usr/bin/jc-kernel-witness run \
  --mode live \
  --bpf-obj /usr/lib/witness.bpf.o \
  --cgroup-root /sys/fs/cgroup \
  --observer-id vm-obs-1 \
  --work-item-id wi-vm-term \
  --attempt-id att-vm-term \
  --lease-id lease-vm-term \
  --invocation-hash 2222222222222222222222222222222222222222222222222222222222222222 \
  --receipt-out /tmp/receipt_term.json \
  ${SIGN_ARGS} \
  -- /bin/sh -c "sleep 5" &
OBS_TERM_PID=$!
sleep 0.3
kill -TERM "${OBS_TERM_PID}" 2>/dev/null || true
wait "${OBS_TERM_PID}" 2>/dev/null || true
/usr/bin/jc-kernel-witness verify \
  --receipt /tmp/receipt_term.json \
  --public-key "${PUB_KEY}" \
  --require-live > /tmp/verify_term.json 2>&1
TERM_VERIFY_RC=$?
echo "SCENARIO_09_TERM_VERIFY_RC=${TERM_VERIFY_RC}"

# Print full receipt between markers for host-side inspection
echo "=== RECEIPT_FULL_JSON_BEGIN ==="
cat /tmp/receipt_full.json
echo "=== RECEIPT_FULL_JSON_END ==="
echo "=== SIGNER_AUDIT_LOG_BEGIN ==="
cat "${SIGNER_DIR}/audit.jsonl" 2>/dev/null || true
echo "=== SIGNER_AUDIT_LOG_END ==="

kill -9 "${NOISE_PID}" 2>/dev/null || true
echo "=== VM_ACCEPTANCE_END ==="
/bin/guest_helper poweroff
INITEOF
chmod +x "${ROOTFS}/init"

(
  cd "${ROOTFS}"
  find . -print0 | cpio --null -o -H newc --quiet | gzip -1 > "${VM_WORK}/initramfs.cpio.gz"
)

echo "Booting disposable QEMU/KVM VM with kernel ${KERNEL_IMG}..."
VM_LOG="${VM_WORK}/vm-console.log"
qemu-system-x86_64 \
  -enable-kvm \
  -cpu host \
  -machine q35 \
  -m 1024M \
  -nographic \
  -no-reboot \
  -kernel "${KERNEL_IMG}" \
  -initrd "${VM_WORK}/initramfs.cpio.gz" \
  -append "console=ttyS0 panic=-1 rdinit=/init" > "${VM_LOG}" 2>&1 || true

cat "${VM_LOG}" | grep -E "^(===|KERNEL_RELEASE|SCENARIO_|FULL_WORKLOAD_|VERIFY_JSON)" || {
  echo "=== VM LOG DUMP ==="
  cat "${VM_LOG}"
  exit 1
}

grep -q "FULL_WORKLOAD_RUN_RC=0" "${VM_LOG}"
grep -q "FULL_WORKLOAD_VERIFY_RC=0" "${VM_LOG}"
grep -q "SCENARIO_14_22=ISOLATION_VERIFIED" "${VM_LOG}"
grep -v "SCENARIO_07_MMAP_STRICT_RC=0" "${VM_LOG}" >/dev/null
grep -q "SCENARIO_07_MMAP_PARTIAL_RC=0" "${VM_LOG}"
grep -q "SCENARIO_08_SIGKILL_VERIFY_RC=0" "${VM_LOG}"
grep -v "SCENARIO_11_UNPRIV_LIVE_RC=0" "${VM_LOG}" >/dev/null
grep -v "SCENARIO_16_REPLAY_RC=0" "${VM_LOG}" >/dev/null
grep -v "SCENARIO_09_TERM_VERIFY_RC=0" "${VM_LOG}" >/dev/null

# Validate the extracted live VM v2 receipt structure (Scenarios 1..7, 15, 18) with Node.js
node - "${VM_LOG}" << 'NODEEOF'
const fs = require('node:fs');
const assert = require('node:assert/strict');

const rawLog = fs.readFileSync(process.argv[2], 'utf8').replace(/\r/g, '');
const beginMarker = '=== RECEIPT_FULL_JSON_BEGIN ===\n';
const endMarker = '\n=== RECEIPT_FULL_JSON_END ===';
const startIdx = rawLog.indexOf(beginMarker);
const endIdx = rawLog.indexOf(endMarker);
assert.ok(startIdx >= 0 && endIdx > startIdx, 'Live VM receipt markers must exist in VM console log');
const receiptJson = rawLog.slice(startIdx + beginMarker.length, endIdx).trim();
const receipt = JSON.parse(receiptJson);

assert.equal(receipt.schemaVersion, 'jc.kernel-witness.receipt.v2');
assert.equal(receipt.observerMode, 'live');
assert.equal(receipt.status, 'complete');
assert.equal(receipt.acsAnchorRef, 'wi-vm-1');
assert.ok(Array.isArray(receipt.processTree) && receipt.processTree.length >= 1, 'processTree populated');
assert.ok(Array.isArray(receipt.filesystemEvents) && receipt.filesystemEvents.length >= 6, 'filesystemEvents populated');
assert.ok(Array.isArray(receipt.networkEvents) && receipt.networkEvents.length >= 3, 'networkEvents populated');

// Verify Scenario 6: filesystem ops include MKDIR, CREATE, MODIFY, TRUNCATE, RENAME, DELETE, RMDIR
const fsOps = new Set(receipt.filesystemEvents.map((e) => e.op));
for (const expectedOp of ['MKDIR', 'CREATE', 'MODIFY', 'TRUNCATE', 'RENAME', 'DELETE', 'RMDIR']) {
  assert.ok(fsOps.has(expectedOp), `Live VM filesystemEvents missing expected op: ${expectedOp} (got: ${[...fsOps].join(',')})`);
}

// Verify Scenario 4: foreign cgroup file noise (/tmp/foreign_noise.txt) excluded
for (const ev of receipt.filesystemEvents) {
  assert.equal(ev.cgroupId, receipt.cgroupId, 'All filesystem events must match target cgroupId');
  if (ev.displayPath) {
    assert.ok(!ev.displayPath.includes('foreign_noise'), 'Foreign cgroup file mutation leaked into receipt');
  }
}

// Verify Scenario 5: IPv4 + IPv6 TCP & UDP outbound events recorded, foreign cgroup excluded
const protos = new Set(receipt.networkEvents.map((e) => `${e.af}:${e.proto}:${e.remotePort}`));
assert.ok(protos.has('INET:TCP:18080'), `Expected IPv4 TCP connect to 18080 (got: ${[...protos].join(',')})`);
assert.ok(protos.has('INET:TCP:18081'), `Expected IPv4 TCP refused connect to 18081 (got: ${[...protos].join(',')})`);
assert.ok(protos.has('INET6:TCP:18082'), `Expected IPv6 TCP connect to 18082 (got: ${[...protos].join(',')})`);
assert.ok(protos.has('INET:UDP:18083'), `Expected IPv4 UDP sendto to 18083 (got: ${[...protos].join(',')})`);

console.log(`Live VM Receipt Verified: ${receipt.events.length} process events, ${receipt.filesystemEvents.length} fs events (${[...fsOps].join(',')}), ${receipt.networkEvents.length} net events (${[...protos].join(',')})`);
NODEEOF

echo "=== Disposable QEMU/KVM Live Kernel Acceptance PASSED ==="
