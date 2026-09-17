// Best-effort browser launch. Never required for `acs auth login` to succeed - the
// verification URL and code are always printed regardless of whether this works.
import { spawn } from "node:child_process";

export function tryOpenBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, process.platform === "win32" ? ["", url] : [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32"
    });
    child.unref();
    child.on("error", () => {
      // Best effort only; the CLI already printed the URL for manual use.
    });
  } catch {
    // Best effort only.
  }
}
