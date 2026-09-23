export function shortId(value: string | undefined, head = 8, tail = 4): string {
  if (!value) return "—";
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function shortHash(value: string | undefined): string {
  return value ? `${value.slice(0, 10)}…` : "—";
}

export function formatTime(iso: string | number | undefined, opts: { seconds?: boolean } = {}): string {
  if (iso === undefined || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" } : {}),
    hour12: false
  });
}

export function relativeAge(from: string | number | undefined, now: number = Date.now()): string {
  if (from === undefined || from === "") return "—";
  const then = typeof from === "number" ? from : Date.parse(from);
  if (Number.isNaN(then)) return "—";
  return formatDuration(Math.max(0, now - then));
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(fraction: number, digits = 1): string {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : "—";
}

/** Stringify without ever throwing (cyclic or BigInt payloads). Output is always rendered as text, never HTML. */
export function safeJson(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), space) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}
