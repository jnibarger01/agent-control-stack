/**
 * Opt-in, X11-only computer-use backend. No shell, no executable supplied by
 * the caller, and no automatic fallback to the operator's desktop.
 * This is deliberately NOT Anthropic's unrestricted bash demo.
 */
import { execFile } from "node:child_process";

export class GuiError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GuiError";
  }
}
export type GuiRunner = (
  binary: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; shell: false }
) => Promise<{ stdout: Buffer }>;

const runFile: GuiRunner = (binary, args, options) =>
  new Promise((resolve, reject) => {
    execFile(binary, args, { ...options, encoding: "buffer" }, (error, stdout) => {
      if (error) return reject(error);
      resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout) });
    });
  });

export interface GuiOptions {
  env?: NodeJS.ProcessEnv;
  runner?: GuiRunner;
}
export type GuiAction =
  | { action: "click" | "move"; x: number; y: number }
  | { action: "drag"; x: number; y: number; toX: number; toY: number }
  | { action: "type" | "key"; text: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; amount: number };

function context(options: GuiOptions) {
  const env = options.env ?? process.env;
  if (env.JC_GUI_ENABLED !== "1") throw new GuiError("GUI_DISABLED", "native computer use is not enabled");
  const display = env.JC_GUI_DISPLAY;
  if (!display || !/^:[0-9]{1,3}(?:\.[0-9])?$/.test(display))
    throw new GuiError("GUI_DISPLAY_INVALID", "explicit X11 display is required");
  const auth = env.JC_GUI_XAUTHORITY;
  if (auth && (!auth.startsWith("/") || auth.includes("\0") || auth.length > 4096))
    throw new GuiError("GUI_DISPLAY_INVALID", "X11 authority path is invalid");
  return {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      DISPLAY: display,
      ...(auth ? { XAUTHORITY: auth } : {}),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8"
    } as NodeJS.ProcessEnv,
    runner: options.runner ?? runFile
  };
}

function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !Object.keys(value).every((k) => keys.includes(k))
  )
    throw new GuiError("GUI_ARGUMENT_INVALID", "unknown or missing GUI action arguments");
}
function coordinate(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8191)
    throw new GuiError("GUI_ARGUMENT_INVALID", "screen coordinates must be bounded nonnegative integers");
  return String(value);
}
function validateAction(value: unknown): string[] {
  if (!value || typeof value !== "object") throw new GuiError("GUI_ARGUMENT_INVALID", "GUI action must be an object");
  const action = (value as { action?: unknown }).action;
  if (action === "click" || action === "move") {
    exactKeys(value, ["action", "x", "y"]);
    const x = coordinate(value.x),
      y = coordinate(value.y);
    return action === "click" ? ["mousemove", "--sync", x, y, "click", "1"] : ["mousemove", "--sync", x, y];
  }
  if (action === "drag") {
    exactKeys(value, ["action", "x", "y", "toX", "toY"]);
    return [
      "mousemove",
      "--sync",
      coordinate(value.x),
      coordinate(value.y),
      "mousedown",
      "1",
      "mousemove",
      "--sync",
      coordinate(value.toX),
      coordinate(value.toY),
      "mouseup",
      "1"
    ];
  }
  if (action === "type") {
    exactKeys(value, ["action", "text"]);
    if (
      typeof value.text !== "string" ||
      value.text.length < 1 ||
      value.text.length > 2048 ||
      value.text.includes("\0")
    )
      throw new GuiError("GUI_ARGUMENT_INVALID", "typed text is invalid");
    return ["type", "--clearmodifiers", "--delay", "12", "--", value.text];
  }
  if (action === "key") {
    exactKeys(value, ["action", "text"]);
    if (typeof value.text !== "string" || !/^[A-Za-z0-9_+]{1,48}$/.test(value.text))
      throw new GuiError("GUI_ARGUMENT_INVALID", "key chord is invalid");
    return ["key", "--clearmodifiers", "--", value.text];
  }
  if (action === "scroll") {
    exactKeys(value, ["action", "direction", "amount"]);
    if (
      !["up", "down", "left", "right"].includes(String(value.direction)) ||
      typeof value.amount !== "number" ||
      !Number.isSafeInteger(value.amount) ||
      value.amount < 1 ||
      value.amount > 15
    )
      throw new GuiError("GUI_ARGUMENT_INVALID", "scroll arguments are invalid");
    const button = { up: "4", down: "5", left: "6", right: "7" }[value.direction as "up" | "down" | "left" | "right"];
    return ["click", "--repeat", String(value.amount), "--delay", "30", button];
  }
  throw new GuiError("GUI_ARGUMENT_INVALID", "unsupported GUI action");
}

/** All validation happens before invoking the X11 backend. */
export async function executeGuiAction(action: unknown, options: GuiOptions = {}): Promise<{ ok: true }> {
  const args = validateAction(action);
  const ctx = context(options);
  try {
    await ctx.runner("/usr/bin/xdotool", args, {
      env: ctx.env,
      // 12ms between keystrokes can take ~25s for the allowed 2048 characters.
      // Bound the timeout without truncating valid input mid-action.
      timeout:
        action && typeof action === "object" &&
        (action as { action?: unknown }).action === "type" &&
        typeof (action as { text?: unknown }).text === "string"
          ? Math.min(40_000, 5000 + (action as { text: string }).text.length * 15)
          : 7000,
      maxBuffer: 64 * 1024,
      shell: false
    });
  } catch {
    // A failed drag may leave the mouse button down. Release it best-effort.
    if (args.includes("mousedown")) {
      try {
        await ctx.runner("/usr/bin/xdotool", ["mouseup", "1"], {
          env: ctx.env,
          timeout: 2000,
          maxBuffer: 1024,
          shell: false
        });
      } catch {
        /* unrecoverable backend failure: still deny */
      }
    }
    throw new GuiError("GUI_BACKEND_UNAVAILABLE", "X11 input action failed");
  }
  return { ok: true };
}

const PNG_HEADER = Buffer.from("89504e470d0a1a0a", "hex");
const MAX_PNG_BYTES = 4 * 1024 * 1024;
export async function captureGuiScreenshot(options: GuiOptions = {}): Promise<{
  mimeType: "image/png";
  data: string;
  width: number;
  height: number;
}> {
  const ctx = context(options);
  let image: Buffer;
  try {
    const result = await ctx.runner("/usr/bin/import", ["-window", "root", "-depth", "8", "png:-"], {
      env: ctx.env,
      timeout: 10000,
      maxBuffer: MAX_PNG_BYTES + 1,
      shell: false
    });
    image = result.stdout;
  } catch {
    throw new GuiError("GUI_BACKEND_UNAVAILABLE", "X11 screenshot failed");
  }
  if (image.length > MAX_PNG_BYTES) throw new GuiError("GUI_CAPTURE_TOO_LARGE", "screenshot exceeds 4 MiB");
  if (image.length < 29 || !image.subarray(0, 8).equals(PNG_HEADER) || image.toString("ascii", 12, 16) !== "IHDR")
    throw new GuiError("GUI_CAPTURE_INVALID", "screenshot is not a PNG");
  const width = image.readUInt32BE(16),
    height = image.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8192 || height > 8192)
    throw new GuiError("GUI_CAPTURE_INVALID", "screenshot dimensions are invalid");
  return { mimeType: "image/png", data: image.toString("base64"), width, height };
}
