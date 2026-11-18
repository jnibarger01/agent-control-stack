import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { startScopeTermination } from "./linux.js";

type Signal = "term" | "kill";
type Event =
  | { type: "cancel" | "deadline_elapsed" | "grace_elapsed" | "launcher_closed" }
  | { type: "scope_signal_completed"; signal: Signal; failed: boolean };
type Effect =
  | { type: "signal_scope" | "signal_launcher"; signal: Signal }
  | { type: "finish"; trigger: "timeout" | "cancelled" | null; signal_failed: boolean }
  | { type: "arm_grace" | "clear_timers" };

const binary = fileURLToPath(
  new URL("../../../rust/scope-supervisor/target/release/acs-scope-supervisor", import.meta.url)
);
const deadlineMs = 200;
const graceMs = 50;
const cancel = { type: "cancel" } as const;
const deadline = { type: "deadline_elapsed" } as const;
const grace = { type: "grace_elapsed" } as const;
const close = { type: "launcher_closed" } as const;
const completed = (signal: Signal, failed = false): Event => ({ type: "scope_signal_completed", signal, failed });
const fixtures: Array<[string, Event[]]> = [
  ["normal close", [close]],
  ["close during TERM after competing triggers", [cancel, deadline, close, completed("term", true)]],
  [
    "close during KILL after competing triggers",
    [deadline, cancel, completed("term"), grace, close, completed("kill")]
  ],
  ["close during grace", [cancel, completed("term"), close]],
  ["failed scope signals", [deadline, completed("term", true), grace, completed("kill", true), close]],
  ["both scope signals complete before close", [cancel, completed("term"), grace, completed("kill"), close]]
];

async function rustTrace(events: Event[]): Promise<Effect[][]> {
  const child = spawn(binary, [], { env: {}, stdio: ["pipe", "pipe", "ignore"], timeout: 4000, killSignal: "SIGKILL" });
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.once("error", () => resolve(null));
  });
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const next = lines[Symbol.asyncIterator]();
  try {
    const trace: Effect[][] = [];
    for (const [index, event] of events.entries()) {
      const seq = index + 1;
      child.stdin.write(JSON.stringify({ version: 1, seq, event }) + "\n");
      const line = await next.next();
      if (line.done) throw new Error(`missing reply to event ${seq}`);
      const reply: { version: number; seq: number; effects: Effect[] } = JSON.parse(line.value);
      expect(reply).toMatchObject({ version: 1, seq, effects: expect.any(Array) });
      trace.push(reply.effects);
    }
    child.stdin.end();
    expect((await next.next()).done).toBe(true);
    expect(await exited).toBe(0);
    return trace;
  } finally {
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}

async function typeScriptTrace(events: Event[]): Promise<Effect[][]> {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const started = Date.now();
    const trace: Effect[][] = [];
    let effects: Effect[] = [];
    let pending: { signal: Signal; report: (failed: boolean) => void } | undefined;
    let finished: Promise<void> | undefined;
    const finish = startScopeTermination({
      wallClockMs: deadlineMs,
      terminationGraceMs: graceMs,
      signal: controller.signal,
      signalUnit: (sig) =>
        new Promise<void>((resolve, reject) => {
          const signal = sig === "SIGTERM" ? "term" : "kill";
          effects.push({ type: "signal_scope", signal });
          pending = {
            signal,
            report: (failed) => {
              if (failed) reject(new Error("fixture scope signal failed"));
              else resolve();
            }
          };
        }),
      signalLauncher: (sig) => effects.push({ type: "signal_launcher", signal: sig === "SIGTERM" ? "term" : "kill" })
    });
    for (const event of events) {
      effects = [];
      switch (event.type) {
        case "cancel":
          controller.abort();
          break;
        case "deadline_elapsed":
          await vi.advanceTimersByTimeAsync(deadlineMs - (Date.now() - started));
          break;
        case "grace_elapsed":
          await vi.advanceTimersByTimeAsync(graceMs);
          break;
        case "launcher_closed":
          finished = finish().then(({ trigger, terminationError }) => {
            effects.push({ type: "finish", trigger: trigger ?? null, signal_failed: terminationError !== undefined });
          });
          break;
        case "scope_signal_completed": {
          if (pending?.signal !== event.signal) throw new Error("fixture has no matching pending signal");
          const report = pending.report;
          pending = undefined;
          report(event.failed);
          break;
        }
      }
      await vi.advanceTimersByTimeAsync(0);
      trace.push(effects);
    }
    expect(finished).toBeDefined();
    await finished;
    expect(vi.getTimerCount()).toBe(0);
    return trace;
  } finally {
    vi.useRealTimers();
  }
}

describe.skipIf(process.env.ACS_TEST_SCOPE_SUPERVISOR !== "1")("isolated Rust scope coordinator parity", () => {
  it.each(fixtures)("%s", async (_name, events) => {
    const native = await rustTrace(events);
    const reference = await typeScriptTrace(events);
    // Rust sends explicit timer directives; TypeScript manages its timers internally.
    expect(native.map((step) => step.filter(({ type }) => type !== "arm_grace" && type !== "clear_timers"))).toEqual(
      reference
    );
  });
});
