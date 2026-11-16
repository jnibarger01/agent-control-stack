/**
 * Collect the observable output of an interactive PTY command across streamed
 * chunks. The first interact_with_process response can contain only terminal
 * echo while the shell is still starting; it is not proof that a command ran.
 *
 * readNext receives absolute stream offsets and a bounded wait duration.
 */
export async function waitForPtyOutput(initial, readNext, expected, timeoutMs = 5_000) {
  let current = initial;
  let stdout = String(initial.stdout ?? '');
  let stdoutOffset = initial.nextStdoutOffset ?? Buffer.byteLength(stdout);
  let stderrOffset = initial.nextStderrOffset ?? 0;
  const deadline = Date.now() + timeoutMs;

  while (!expected.test(stdout) && current.running !== false && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    current = await readNext({
      stdoutOffset,
      stderrOffset,
      waitMs: Math.min(300, Math.max(1, remaining))
    });
    stdout += String(current.stdout ?? '');
    stdoutOffset = current.nextStdoutOffset ?? stdoutOffset + Buffer.byteLength(String(current.stdout ?? ''));
    stderrOffset = current.nextStderrOffset ?? stderrOffset + Buffer.byteLength(String(current.stderr ?? ''));
  }
  return stdout;
}
