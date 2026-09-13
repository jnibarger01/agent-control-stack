/**
 * ADR 0016 Slice 5 - block the generic `cmd.run` shell surface from being
 * used to invoke Desktop Commander directly, bypassing the governed
 * `@agent-control-stack/desktop-commander-adapter` execution boundary (its
 * policy, approval, containment, and audit chain) entirely.
 *
 * `previewCommand` already receives `command` and `args` as discrete,
 * pre-split tokens (never a raw shell string), so this reuses that
 * structure rather than re-parsing or substring-matching a command line.
 * Every token (the executable AND every argument) is checked, because the
 * bypass forms that matter put the real target in an argument, not the
 * executable: `npx @wonderwhy-er/desktop-commander`, `node
 * /path/to/desktop-commander/dist/index.js`, etc.
 *
 * This is intentionally narrow: it flags only tokens that name Desktop
 * Commander itself (by package name, executable name, or a
 * "desktop-commander" path segment). Unrelated `node`, `npm`, or `npx`
 * commands are unaffected.
 */

const desktopCommanderPackagePattern = /^@wonderwhy-er\/desktop-commander\b/i;
const desktopCommanderPathSegmentPattern = /(^|[\\/])desktop-commander([\\/]|$)/i;

function stripVersionSpecifier(token: string): string {
  // "desktop-commander@1.2.3" / "@wonderwhy-er/desktop-commander@latest" ->
  // drop a trailing "@<version>" without touching a leading scope "@wonderwhy-er/".
  const lastAt = token.lastIndexOf("@");
  if (lastAt <= 0) return token;
  return token.slice(0, lastAt);
}

function tokenNamesDesktopCommander(token: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const trimmed = token.trim();
  if (trimmed.length === 0) return false;

  if (desktopCommanderPackagePattern.test(trimmed)) return true;
  if (desktopCommanderPackagePattern.test(stripVersionSpecifier(trimmed))) return true;
  if (desktopCommanderPathSegmentPattern.test(trimmed)) return true;

  const basename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  const basenameWithoutVersion = stripVersionSpecifier(basename);
  if (basename === "desktop-commander" || basenameWithoutVersion === "desktop-commander") return true;

  return false;
}

/**
 * True when `command` or any entry in `args` names Desktop Commander -
 * covering the executable itself (`desktop-commander`), an npx/npm package
 * spec (`npx @wonderwhy-er/desktop-commander`, with or without a version),
 * and a direct path to a Desktop Commander build (any argument with a
 * `desktop-commander` path segment, e.g. `node
 * .../desktop-commander/dist/index.js`).
 */
export function isDesktopCommanderBypassAttempt(command: string, args: readonly string[]): boolean {
  if (tokenNamesDesktopCommander(command)) return true;
  return args.some(tokenNamesDesktopCommander);
}
