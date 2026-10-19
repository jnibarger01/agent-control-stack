/** Presentation helpers. They never invent values: bad input renders as "unknown". */

export function shortId(id: string, keep = 8): string {
  const underscore = id.indexOf("_");
  const prefix = underscore > 0 && underscore <= 4 ? id.slice(0, underscore + 1) : "";
  const body = id.slice(prefix.length);
  return body.length <= keep + 1 ? id : `${prefix}${body.slice(0, keep)}…`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

export function relativeTime(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const delta = Math.round((nowMs - t) / 1000);
  const abs = Math.abs(delta);
  const unit = abs < 60 ? [abs, "s"] : abs < 3600 ? [Math.round(abs / 60), "m"] : abs < 86400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86400), "d"];
  return delta >= 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}

export function clockTime(iso: string | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function percent(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "unknown";
}
