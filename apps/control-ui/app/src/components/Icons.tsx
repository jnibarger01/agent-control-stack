import type { ComponentType, SVGProps } from "react";
import type { RouteId } from "../router";

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="30"
      height="30"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M4 26 15.5 4h3L30 26h-6l-2.4-5H10.4L8 26H4Zm9-10h4l-2-4-2 4Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

function Svg({ title, children, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function IconOverview(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  );
}
export function IconWork(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </Svg>
  );
}
export function IconExecution(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8l6 4-6 4z" fill="currentColor" stroke="none" />
    </Svg>
  );
}
export function IconApprovals(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 11l2.2 2.2L16 8.5" />
      <rect x="4" y="4" width="16" height="16" rx="3" />
    </Svg>
  );
}
export function IconAgents(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19c.8-3.2 3.2-5 6.5-5s5.7 1.8 6.5 5" />
    </Svg>
  );
}
export function IconRuntimes(props: IconProps) {
  return <Svg {...props}><rect x="3" y="4" width="7" height="6" rx="1.5" /><rect x="14" y="4" width="7" height="6" rx="1.5" /><rect x="8.5" y="15" width="7" height="5" rx="1.5" /><path d="M6.5 10v2h11v-2M12 12v3" /></Svg>;
}
export function IconConnectors(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 7H7a4 4 0 000 8h2" />
      <path d="M15 7h2a4 4 0 010 8h-2" />
      <path d="M8 12h8" />
    </Svg>
  );
}
export function IconPolicy(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l8 3v6c0 5-3.4 7.6-8 9-4.6-1.4-8-4-8-9V6z" />
    </Svg>
  );
}
export function IconAudit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4h8l4 4v12H7z" />
      <path d="M15 4v4h4M9 13h6M9 17h4" />
    </Svg>
  );
}
export function IconMetrics(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
    </Svg>
  );
}
export function IconSystem(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M8 21h8M12 18v3" />
    </Svg>
  );
}
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  );
}
export function IconOnline(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M5 12a7 7 0 0114 0M2 12a10 10 0 0120 0" />
    </Svg>
  );
}
export function IconRunning(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}
export function IconPending(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5h4" />
    </Svg>
  );
}
export function IconBlocked(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 8l8 8" />
    </Svg>
  );
}
export function IconFailed(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 16h.01" />
    </Svg>
  );
}
export function IconLease(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="7" width="16" height="12" rx="2" />
      <path d="M8 7V5a4 4 0 018 0v2" />
    </Svg>
  );
}
export function IconAttention(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 16h.01" />
    </Svg>
  );
}
export function IconStream(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7c4-4 12-4 16 0M7 11c3-3 7-3 10 0M10 15a4 4 0 004 0" />
      <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

const NAV: Record<Exclude<RouteId, "not-found">, ComponentType<IconProps>> = {
  overview: IconOverview,
  work: IconWork,
  execution: IconExecution,
  approvals: IconApprovals,
  agents: IconAgents,
  runtimes: IconRuntimes,
  connectors: IconConnectors,
  policy: IconPolicy,
  audit: IconAudit,
  metrics: IconMetrics,
  system: IconSystem
};

export function NavIcon({ id }: { id: Exclude<RouteId, "not-found"> }) {
  const Cmp = NAV[id];
  return <Cmp className="nav-link-icon" />;
}
