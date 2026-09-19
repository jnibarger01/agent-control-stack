import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, ROUTES, useRouter, type RouteId } from "../router";
import { useHealth, useSession, useWorkItems, eventStream } from "../state/data";

/** Minimal inline icon set: no icon-font or third-party asset, so it stays inside a strict script-src 'self' CSP. */
const NAV_ICON_PATHS: Record<Exclude<RouteId, "not-found">, string> = {
  overview: "M3 12h4l2-7 4 14 2-7h4",
  work: "M4 6h16M4 12h16M4 18h10",
  execution: "M6 4l12 8-12 8V4z",
  approvals: "M5 12l4 4 10-10",
  agents: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 5-6s5 2.7 5 6M16 8a2.6 2.6 0 1 0 0-5.2M17 14.2c2 .4 3.5 2.3 3.5 5.8",
  connectors: "M9 2v4M15 2v4M6 8h12l-1 5a5 5 0 0 1-10 0L6 8zM12 17v5",
  policy: "M12 2l8 3v6c0 5-3.4 8.4-8 11-4.6-2.6-8-6-8-11V5l8-3z",
  audit: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6",
  metrics: "M4 20V10M11 20V4M18 20v-7",
  system: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"
};

function NavIcon({ id }: { id: Exclude<RouteId, "not-found"> }) {
  return (
    <svg
      className="nav-link-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={NAV_ICON_PATHS[id]} />
    </svg>
  );
}
import { useEventStream, isStreamTrustworthy, type StreamStatus } from "../state/events";
import { SearchPalette } from "./SearchPalette";

export function useStreamTrust(): { status: StreamStatus; trustworthy: boolean } {
  const snapshot = useEventStream(eventStream);
  return { status: snapshot.status, trustworthy: isStreamTrustworthy(snapshot.status) };
}

function environmentLabel(): { label: string; remote: boolean } {
  const host = window.location.hostname;
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  return loopback ? { label: "local", remote: false } : { label: host, remote: true };
}

function GatewayIndicator() {
  const health = useHealth();
  let tone: "success" | "danger" | "warning" | "" = "";
  let text = "Checking";
  if (health.hasData && health.data) {
    const { readyz, livez } = health.data;
    if ("error" in livez) {
      tone = "danger";
      text = "Unreachable";
    } else if ("error" in readyz) {
      tone = "warning";
      text = "Live · readiness unknown";
    } else if (readyz.httpStatus === 200 && readyz.ok) {
      tone = "success";
      text = "Ready";
    } else {
      tone = "danger";
      text = "Not ready";
    }
  } else if (health.error) {
    tone = "danger";
    text = "Unreachable";
  }
  return (
    <Link
      to="/system"
      className="chip"
      data-tone={tone || undefined}
      aria-label={`Gateway ${text}. Open system status.`}
    >
      <span className="dot" data-tone={tone || undefined} aria-hidden="true" />
      <span className="hide-narrow">Gateway</span> {text}
    </Link>
  );
}

function OperatorIdentity() {
  const session = useSession();
  const identity = session.data;
  const label = identity ? (identity.actorId ?? identity.actor) : undefined;
  const role = identity?.roles[0];
  return (
    <span
      className="chip hide-narrow"
      title={identity ? `Signed in as ${label}${role ? ` (${role})` : ""}` : "Operator session"}
    >
      {label ?? "Operator session"}
    </span>
  );
}

function StreamIndicator() {
  const snap = useEventStream(eventStream);
  const [, tick] = useState(0);
  useEffect(() => {
    if (snap.status !== "reconnecting") return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [snap.status]);
  const map: Record<StreamStatus, { text: string; tone: "success" | "warning" | "danger" | "" }> = {
    live: { text: "Live", tone: "success" },
    connecting: { text: "Connecting", tone: "warning" },
    reconnecting: { text: "Reconnecting", tone: "warning" },
    unauthorized: { text: "Signed out", tone: "danger" },
    stopped: { text: "Stopped", tone: "danger" }
  };
  const { text, tone } = map[snap.status];
  const retry =
    snap.status === "reconnecting" && snap.nextRetryAt
      ? Math.max(0, Math.ceil((snap.nextRetryAt - Date.now()) / 1000))
      : undefined;
  return (
    <span
      className="chip"
      data-tone={tone || undefined}
      role="status"
      aria-live="polite"
      aria-label={`Event stream ${text}${retry !== undefined ? `, retrying in ${retry} seconds` : ""}`}
    >
      <span className="dot" data-tone={tone || undefined} aria-hidden="true" />
      <span className="hide-narrow">Events</span> {text}
      {retry !== undefined && <span className="hide-narrow"> · {retry}s</span>}
    </span>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { route, location } = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { status, trustworthy } = useStreamTrust();
  const work = useWorkItems();
  const env = environmentLabel();
  const pending = useMemo(
    () => (work.data ?? []).filter((item) => item.status === "needs_approval").length,
    [work.data]
  );

  // Close the mobile nav after navigating.
  useEffect(() => setNavOpen(false), [location.path]);

  // Ctrl/⌘+K and "/" open search; ignored while typing in a field.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "Escape") {
        setNavOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar" data-open={navOpen} aria-label="Mission Control">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ACS
          </span>
          <div>
            ACS Mission Control
            <small>Agents. Policy. Audit.</small>
          </div>
        </div>
        <nav className="nav" aria-label="Primary">
          {ROUTES.map((item) => (
            <Link
              key={item.id}
              to={item.path}
              className="nav-link"
              aria-current={route.id === item.id ? "page" : undefined}
            >
              <NavIcon id={item.id} />
              <span className="nav-link-label">{item.label}</span>
              {item.id === "approvals" && pending > 0 && (
                <span className="nav-count" aria-label={`${pending} awaiting approval`}>
                  {pending}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          Local-first control plane.
          <br />
          State is read from the ACS gateway; this UI holds no authority.
        </div>
      </aside>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <header className="topbar" role="banner">
        <button
          type="button"
          className="btn nav-toggle"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          onClick={() => setNavOpen((open) => !open)}
        >
          ☰
        </button>
        <button
          type="button"
          className="search-trigger"
          onClick={() => setSearchOpen(true)}
          aria-label="Search work items, agents, connectors"
          aria-keyshortcuts="Control+K Meta+K /"
        >
          <span aria-hidden="true">⌕</span>
          <span className="label-long">Search work, agents, connectors…</span>
          <kbd aria-hidden="true">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <div className="topbar-spacer" />
        <div className="status-cluster">
          <GatewayIndicator />
          <span
            className="chip hide-narrow"
            data-tone={env.remote ? "warning" : undefined}
            title="Environment derived from the address this console is served from"
          >
            Env: {env.label}
          </span>
          <StreamIndicator />
          <OperatorIdentity />
        </div>
      </header>
      <main className="main" id="main-content" tabIndex={-1}>
        {!trustworthy && status !== "stopped" && (
          <div
            className="banner"
            data-tone="warning"
            role="status"
            id="stream-stale-banner"
            style={{ marginBottom: "var(--space-4)" }}
          >
            <div>
              <strong>
                {status === "unauthorized"
                  ? "Event stream rejected the session."
                  : "Live event stream is not connected."}
              </strong>
              <p>
                Displayed data may be stale. Approve, reject and unblock are disabled until the stream is live again.
              </p>
              {status !== "unauthorized" && (
                <button type="button" className="btn" data-size="sm" onClick={() => eventStream.reconnectNow()}>
                  Reconnect now
                </button>
              )}
            </div>
          </div>
        )}
        {children}
      </main>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
