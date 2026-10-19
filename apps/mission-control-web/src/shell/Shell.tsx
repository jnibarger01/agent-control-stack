import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router";
import type { OverviewReadModel } from "@agent-control-stack/mission-control-contract";
import { Kbd, StaleBanner, StatusPill, type Tone } from "../design/primitives";
import { useTheme } from "../design/theme";
import type { StreamState } from "../data/stream";
import { NAV_ITEMS } from "./nav";
import { Palette } from "./Palette";

export function ExecutionBadge({ execution }: { execution: OverviewReadModel["execution"] | undefined }) {
  if (!execution) return <StatusPill tone="unknown">Execution mode unknown</StatusPill>;
  const mode: { tone: Tone; text: string } =
    execution.mode === "strict" ? { tone: "ok", text: "Strict mode" } : execution.mode === "admin" ? { tone: "bad", text: "ADMIN mode, approval disabled" } : { tone: "unknown", text: execution.modeProblem ? `Mode unknown (${execution.modeProblem})` : "Mode unknown" };
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Execution mode">
      <StatusPill tone={mode.tone}>{mode.text}</StatusPill>
      {execution.dryRun === "yes" && <StatusPill tone="warn" glyph="◌">Dry run, simulated</StatusPill>}
      {execution.dryRun === "no" && <StatusPill tone="info">Backend: {execution.backend}</StatusPill>}
      {execution.dryRun === "unknown" && <StatusPill tone="unknown">Backend unknown</StatusPill>}
    </div>
  );
}

function LiveIndicator({ stream }: { stream: StreamState }) {
  const map: Record<StreamState, { tone: Tone; text: string }> = {
    live: { tone: "ok", text: "Live" },
    connecting: { tone: "neutral", text: "Connecting" },
    stale: { tone: "warn", text: "Disconnected" }
  };
  return (
    <span role="status" aria-live="polite">
      <StatusPill tone={map[stream].tone}>{map[stream].text}</StatusPill>
    </span>
  );
}

const themeLabel = { system: "System", dark: "Dark", light: "Light" } as const;

export function Shell({ overview, stream, children, title, subtitle }: { overview: OverviewReadModel | undefined; stream: StreamState; children: ReactNode; title: string; subtitle?: ReactNode }) {
  const { choice, cycle } = useTheme();
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const badge = (key: string): number | undefined => {
    if (!overview) return undefined;
    if (key === "approvals") return overview.needsYou.approvals;
    if (key === "queue") return overview.needsYou.approvals + overview.needsYou.blocked + overview.needsYou.quarantined;
    return undefined;
  };
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
      <a className="skip-link" href="#main">Skip to main content</a>
      <aside aria-label="Mission Control navigation" className="border-b border-line bg-surface/80 p-4 backdrop-blur lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <div className="mb-5 flex items-center gap-3 px-1">
          <svg viewBox="0 0 40 42" width="30" height="32" aria-hidden="true"><path fill="var(--accent)" d="M18 3a3 3 0 0 1 5 0l7 12H11z" /><path fill="var(--violet)" d="M9 19h12L10 38H0z" /><path fill="var(--cyan)" d="M24 19h8l8 19H30z" /></svg>
          <div className="leading-tight"><div className="text-lg font-semibold tracking-tight">ACS</div><div className="text-xs text-muted">Mission Control</div></div>
        </div>
        <nav aria-label="Primary">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {NAV_ITEMS.map((item) => {
              const count = badge(item.key);
              const base = "flex items-center justify-between gap-2 whitespace-nowrap rounded-ctl px-3 py-2 text-sm transition-colors";
              return (
                <li key={item.key}>
                  {item.route ? (
                    <NavLink to={item.route} end={item.route === "/"} className={({ isActive }) => `${base} ${isActive ? "bg-accent-soft font-medium text-ink shadow-[inset_2px_0_0_var(--accent)]" : "text-muted hover:bg-surface-2 hover:text-ink"}`}>
                      <span>{item.label}</span>
                      {count ? <span className="rounded-full bg-warn-soft px-1.5 text-xs font-medium text-warn" aria-label={`${count} need attention`}>{count}</span> : null}
                    </NavLink>
                  ) : (
                    <a href={item.classic} className={`${base} text-muted hover:bg-surface-2 hover:text-ink`}>
                      <span>{item.label}</span>
                      <span className="flex items-center gap-1.5">
                        {count ? <span className="rounded-full bg-warn-soft px-1.5 text-xs font-medium text-warn" aria-label={`${count} need attention`}>{count}</span> : null}
                        <span className="text-[10px] uppercase tracking-wider text-faint">classic</span>
                      </span>
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <p className="mt-6 hidden px-1 text-xs leading-relaxed text-faint lg:block">Approvals and execution controls use the same authenticated routes as the classic console, which stays available at <a className="text-accent hover:underline" href="/legacy">/legacy</a>. <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> jumps to a page.</p>
      </aside>
      <div className="min-w-0">
        <StaleBanner show={stream === "stale"} />
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 lg:px-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ExecutionBadge execution={overview?.execution} />
            <LiveIndicator stream={stream} />
            <button type="button" onClick={() => setPalette(true)} className="flex items-center gap-2 rounded-ctl border border-line bg-surface px-3 py-1.5 text-sm text-muted hover:text-ink">Go to… <Kbd>Ctrl K</Kbd></button>
            <button type="button" onClick={cycle} className="rounded-ctl border border-line bg-surface px-3 py-1.5 text-sm text-muted hover:text-ink" aria-label={`Theme: ${themeLabel[choice]}. Activate to change.`}>Theme: {themeLabel[choice]}</button>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="px-5 py-6 lg:px-8">{children}</main>
      </div>
      <Palette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
