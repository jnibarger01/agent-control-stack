import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { describeError, errorHeadline, isAcsApiError } from "../api/errors";
import { workItemStatusMeta, riskMeta, type StatusMeta, type Tone } from "../domain/status";
import { Link } from "../router";

export function Badge({ meta, title }: { meta: StatusMeta; title?: string }) {
  return (
    <span className="badge" data-tone={meta.tone} title={title}>
      {meta.label}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge meta={workItemStatusMeta(status)} />;
}

export function RiskBadge({ risk }: { risk: string }) {
  return <Badge meta={riskMeta(risk)} />;
}

export function Card({
  title,
  action,
  children,
  flush,
  className,
  id,
  labelledBy
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
  labelledBy?: string;
}) {
  return (
    <section
      className={`card${className ? ` ${className}` : ""}`}
      id={id}
      {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
    >
      {title !== undefined && (
        <header className="card-head">
          <h2 id={labelledBy}>{title}</h2>
          {action}
        </header>
      )}
      <div className="card-body" data-flush={flush ? "true" : "false"}>
        {children}
      </div>
    </section>
  );
}

export function Stat({
  label,
  value,
  note,
  tone,
  to
}: {
  label: string;
  value: ReactNode;
  note?: string;
  tone?: Tone;
  to?: string;
}) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value" data-tone={tone}>
        {value}
      </span>
      {note && <span className="stat-note">{note}</span>}
    </>
  );
  return to ? (
    <Link
      className="card stat"
      to={to}
      aria-label={`${label}: ${typeof value === "number" || typeof value === "string" ? value : ""}${note ? `. ${note}` : ""}. Open details.`}
    >
      {body}
    </Link>
  ) : (
    <div className="card stat">{body}</div>
  );
}

export function Banner({
  tone,
  title,
  children,
  role,
  id
}: {
  tone: "warning" | "danger" | "info" | "success";
  title?: string;
  children?: ReactNode;
  role?: "status" | "alert";
  id?: string;
}) {
  return (
    <div className="banner" data-tone={tone} role={role ?? (tone === "danger" ? "alert" : "status")} id={id}>
      <div>
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

/** Errors keep their authority class: 401/403/409/429/5xx/network each read differently. */
export function ErrorState({ error, onRetry, what }: { error: unknown; onRetry?: () => void; what?: string }) {
  const kind = isAcsApiError(error) ? error.kind : undefined;
  return (
    <div className="state" role="alert" data-error-kind={kind ?? "unknown"}>
      <strong>
        {isAcsApiError(error) ? errorHeadline(error) : "Something went wrong"}
        {what ? ` — ${what}` : ""}
      </strong>
      <p>{describeError(error)}</p>
      {kind === "forbidden" && (
        <p className="hint">Your session is signed in but is not permitted to do this. Nothing was changed.</p>
      )}
      {onRetry && (kind === undefined || (isAcsApiError(error) && error.kind !== "forbidden")) && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function KV({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Progress({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  return <progress className="progress" value={value} max={max} aria-label={label} />;
}

export interface MeterSegment {
  label: string;
  value: number;
  tone: Tone;
}

/** Proportion bar with a text legend, so meaning never depends on colour alone. */
export function Meter({ segments, label }: { segments: MeterSegment[]; label: string }) {
  const total = segments.reduce((sum, seg) => sum + seg.value, 0);
  return (
    <div
      className="meter"
      role="img"
      aria-label={`${label}: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`}
    >
      <div className="meter-track">
        {total > 0 &&
          segments.map((seg) => (
            <span
              key={seg.label}
              className="meter-seg"
              data-tone={seg.tone}
              style={{ width: `${(seg.value / total) * 100}%` }}
            />
          ))}
      </div>
      <div className="row muted" style={{ fontSize: "var(--text-xs)" }}>
        {segments.map((seg) => (
          <span key={seg.label} className="row" style={{ gap: 4 }}>
            <span className="dot" data-tone={seg.tone} /> {seg.label} {seg.value}
          </span>
        ))}
      </div>
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  }, [value]);
  return (
    <button
      type="button"
      className="btn"
      data-size="sm"
      data-variant="ghost"
      onClick={() => void copy()}
      aria-label={`Copy ${label}`}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      <span className="visually-hidden" aria-live="polite">
        {state === "copied" ? `${label} copied to clipboard` : state === "failed" ? "Clipboard unavailable" : ""}
      </span>
    </button>
  );
}

/** Untrusted event/work-item text is only ever rendered through React text nodes; this is the one JSON viewer. */
export function JsonView({ value, label }: { value: unknown; label: string }) {
  let text: string;
  try {
    text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) ?? "undefined";
  } catch {
    text = "[unserializable]";
  }
  return (
    <pre className="json" tabIndex={0} aria-label={label}>
      {text}
    </pre>
  );
}

export function PageHead({
  title,
  description,
  actions
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

/** Marks a panel whose backing contract does not exist in the gateway, instead of faking data. */
export function MissingContract({ what, detail }: { what: string; detail: string }) {
  return (
    <div className="banner" data-tone="info" role="note">
      <div>
        <strong>{what}: not available</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}
