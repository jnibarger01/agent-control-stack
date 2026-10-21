import { useEffect, useId, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "./cn";
import { shortId } from "./format";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "accent" | "unknown";

const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink border-line-strong",
  ok: "bg-ok-soft text-ok border-ok/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  bad: "bg-bad-soft text-bad border-bad/30",
  info: "bg-info-soft text-info border-info/30",
  accent: "bg-accent-soft text-accent border-accent/30",
  unknown: "bg-transparent text-muted border-dashed border-line-strong"
};

/** Status is always text plus a glyph, never colour alone. */
export function StatusPill({ tone = "neutral", children, glyph }: { tone?: Tone; children: ReactNode; glyph?: string }) {
  const g = glyph ?? { ok: "●", warn: "▲", bad: "✕", info: "◆", accent: "◆", unknown: "?", neutral: "•" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", toneClass[tone])}>
      <span aria-hidden="true" className="text-[10px] leading-none">{g}</span>
      {children}
    </span>
  );
}

export function Card({ title, subtitle, action, children, className, id, tone }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string; tone?: "bad" | "warn" | "accent" }) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cn(
        "rounded-card border border-line bg-surface p-5 shadow-[var(--shadow)]",
        tone === "bad" && "border-bad/40",
        tone === "warn" && "border-warn/40",
        tone === "accent" && "border-accent/40",
        className
      )}
    >
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 id={headingId} className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, note, tone, href, to }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone; href?: string; to?: string }) {
  const body = (
    <>
      <span className="text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
      <span className={cn("mt-1 block text-3xl font-semibold tabular-nums tracking-tight", tone === "bad" && "text-bad", tone === "warn" && "text-warn", tone === "ok" && "text-ok")}>{value}</span>
      {note && <span className="mt-1 block text-xs text-muted">{note}</span>}
    </>
  );
  const cls = "block rounded-card border border-line bg-surface p-4 shadow-[var(--shadow)] transition-colors";
  return to ? (
    <Link to={to} className={cn(cls, "hover:border-accent/50")}>{body}</Link>
  ) : href ? (
    <a href={href} className={cn(cls, "hover:border-accent/50")}>{body}</a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Abbreviated identifier: copyable, full value on hover/focus/title. Never the primary label. */
export function IdChip({ id }: { id: string }) {
  return (
    <button
      type="button"
      title={`${id} (click to copy)`}
      aria-label={`${shortId(id)}, copy full identifier`}
      onClick={() => {
        void navigator.clipboard?.writeText(id).catch(() => undefined);
      }}
      className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-ink"
    >
      {shortId(id)}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{children}</kbd>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("acs-skeleton h-4 w-full", className)} />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-ctl border border-dashed border-line-strong px-4 py-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mt-1 text-xs text-muted">{children}</p>}
    </div>
  );
}

/** Fail-closed placeholder: shown instead of any number or list whose source is unavailable. */
export function Unavailable({ what, reason }: { what: string; reason?: string }) {
  return (
    <div role="status" className="rounded-ctl border border-dashed border-warn/40 bg-warn-soft px-4 py-5 text-sm">
      <p className="font-medium text-warn">{what} unavailable</p>
      <p className="mt-1 text-xs text-muted">ACS did not return this data{reason ? ` (${reason})` : ""}. Nothing is inferred in its place.</p>
    </div>
  );
}

export function StaleBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div role="status" className="border-b border-warn/40 bg-warn-soft px-4 py-2 text-center text-sm text-warn">
      Live stream disconnected. Showing the last data received; it may be out of date. Reconnecting…
    </div>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="acs-in h-full w-full max-w-md overflow-y-auto border-l border-line bg-surface p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md border border-line px-2 py-1 text-sm text-muted hover:text-ink" aria-label="Close details">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface Column<T> { key: string; header: string; render: (row: T) => ReactNode; className?: string }

export function DataTable<T>({ caption, columns, rows, rowKey }: { caption: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string }) {
  return (
    <div tabIndex={0} role="region" aria-label={`${caption} (scrollable)`} className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="border-b border-line px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-line/60 last:border-0">
              {columns.map((c) => (
                <td key={c.key} className={cn("px-3 py-2 align-top", c.className)}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
