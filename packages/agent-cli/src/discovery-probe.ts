import { spawn } from "node:child_process";
import { homedir } from "node:os";

/**
 * Process execution for actor discovery. The work-items package decides what to probe and records the result; the
 * spawn itself lives here, with the other agent-CLI process execution, so no domain package starts processes.
 */

// Cold starts are slow (hermes --version took 6.5s cold, 0.2s warm); a short timeout makes the roster flap.
export const DISCOVERY_PROBE_TIMEOUT_MS = 10_000;
const DISCOVERY_PROBE_ERROR_MAX_LENGTH = 200;
const DISCOVERY_PROBE_OUTPUT_MAX_BYTES = 2_000;

export interface DiscoveryProbeResult {
  ok: boolean;
  timedOut?: boolean;
  error?: string;
}

function sanitize(value: string): string {
  let normalized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    normalized += codePoint < 0x20 || codePoint === 0x7f ? " " : character;
  }
  return normalized.replace(/\s+/g, " ").trim().slice(0, DISCOVERY_PROBE_ERROR_MAX_LENGTH);
}

/**
 * Runs `<executable> --version`-style probes without a shell and with an allowlisted environment (no provider
 * credentials, no ACS secrets). Never rejects: every failure is reported as `ok: false`.
 */
export function probeExecutableVersion(
  executablePath: string,
  args: readonly string[],
  timeoutMs = DISCOVERY_PROBE_TIMEOUT_MS
): Promise<DiscoveryProbeResult> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: DiscoveryProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(executablePath, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir() }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // A grandchild can keep the pipes open after the probe is killed, which would defer "close" indefinitely.
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ ok: false, timedOut: true, error: sanitize(`timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    const collect = (chunk: Buffer) => {
      if (output.length < DISCOVERY_PROBE_OUTPUT_MAX_BYTES) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish({ ok: false, error: sanitize(error.message) }));
    child.on("close", (code, signal) => {
      if (timedOut) return;
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: sanitize(`exited with ${code ?? signal}: ${output}`) });
      }
    });
  });
}
