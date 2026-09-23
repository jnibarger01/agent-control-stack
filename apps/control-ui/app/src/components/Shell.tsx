import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, ROUTES, useRouter } from "../router";
import { useHealth, useMetrics, useWorkItems, eventStream } from "../state/data";
import { useEventStream, isStreamTrustworthy, type StreamStatus } from "../state/events";
import { SearchPalette } from "./SearchPalette";
import { BrandMark, NavIcon } from "./Icons";

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
  const metrics = useMetrics();
  let tone: "success" | "danger" | "warning" | "" = "";
  let text = "Checking";
  if (health.hasData && health.data) {
    const { readyz, livez } = health.data;
    if ("error" in livez) {
      tone = "danger";
      text = "Unreachable";
    } else if ("error" in readyz) {
      tone = "warning";
      text = "Live · not ready";
    } else if (readyz.httpStatus === 200 && readyz.ok) {
      tone = "success";
      text = "Online";
    } else {
      tone = "danger";
      text = "Not ready";
    }
  } else if (health.error) {
    tone = "danger";
    text = "Unreachable";
  }
  const latencyMs = metrics.data?.summary.avgLatencySeconds;
  const latency =
    latencyMs !== undefined && Number.isFinite(latencyMs) ? `${Math.round(latencyMs * 1000)} ms` : undefined;
  return (
    <Link
      to="/system"
      className="chip chip-gateway"
      data-tone={tone || undefined}
      aria-label={`Gateway ${text}${latency ? `, average ${latency}` : ""}. Open system status.`}
    >
      <span className="dot" data-tone={tone || undefined} aria-hidden="true" />
      <span className="hide-narrow">Gateway</span> {text}
      {latency ? <span className="chip-meta hide-narrow">{latency}</span> : null}
    </Link>
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
      <span className="hide-narrow">Event Stream</span> {text}
      {retry !== undefined && <span className="hide-narrow"> · {retry}s</span>}
    </span>
  );
}

function GatewayRailCard() {
  const health = useHealth();
  const env = environmentLabel();
  let status = "Checking";
  let tone: "success" | "danger" | "warning" | "" = "";
  if (health.hasData && health.data) {
    const { livez, readyz } = health.data;
    if ("error" in livez) {
      status = "Unreachable";
      tone = "danger";
    } else if ("error" in readyz || readyz.httpStatus !== 200 || !readyz.ok) {
      status = "Degraded";
      tone = "warning";
    } else {
      status = "All systems nominal";
      tone = "success";
    }
  } else if (health.error) {
    status = "Unreachable";
    tone = "danger";
  }
  return (
    <Link to="/system" className="gateway-rail" aria-label={`Gateway ${status}. Open system status.`}>
      <span className="row" style={{ gap: 8 }}>
        <span className="dot" data-tone={tone || undefined} aria-hidden="true" />
        <strong>Gateway {tone === "success" ? "Online" : status}</strong>
      </span>
      <span className="gateway-rail-meta">
        {env.label}
        <br />
        {status}
      </span>
    </Link>
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

  useEffect(() => setNavOpen(false), [location.path]);

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
        <div className="brand">
          <span className="brand-mark">
            <BrandMark />
          </span>
          <div>
            ACS Mission Control
            <small>Agents. Governance. Real Outcomes.</small>
          </div>
        </div>
        <button
          type="button"
          className="search-trigger"
          onClick={() => setSearchOpen(true)}
          aria-label="Search work items, agents, connectors"
          aria-keyshortcuts="Control+K Meta+K /"
        >
          <span aria-hidden="true">⌕</span>
          <span className="label-long">Search agents, tasks, work items, or run IDs…</span>
          <kbd aria-hidden="true">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <div className="topbar-spacer" />
        <div className="status-cluster">
          <GatewayIndicator />
          <span
            className="chip hide-narrow"
            data-tone={env.remote ? "warning" : undefined}
            title="Environment is the host this console is served from. ACS has no environment-switch contract."
          >
            {env.remote ? env.label : "local"}
          </span>
          <StreamIndicator />
          <span
            className="operator-chip hide-narrow"
            title="The gateway exposes no identity endpoint. The session cookie is HttpOnly, so the operator name cannot be shown."
          >
            <span className="operator-avatar" aria-hidden="true">
              OP
            </span>
            <span>
              Operator
              <small>Session</small>
            </span>
          </span>
        </div>
      </header>
      <aside className="sidebar" data-open={navOpen} aria-label="Mission Control">
        <nav className="nav" aria-label="Primary">
          {ROUTES.map((item) => (
            <Link
              key={item.id}
              to={item.path}
              className="nav-link"
              aria-current={route.id === item.id ? "page" : undefined}
            >
              <span className="nav-link-main">
                <NavIcon id={item.id} />
                {item.label}
              </span>
              {item.id === "approvals" && pending > 0 && (
                <span className="nav-count" aria-label={`${pending} awaiting approval`}>
                  {pending}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <GatewayRailCard />
      </aside>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />}
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
