import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode
} from "react";

export const BASE_PATH = "/console";

export type RouteId =
  | "overview"
  | "work"
  | "execution"
  | "approvals"
  | "agents"
  | "connectors"
  | "policy"
  | "audit"
  | "metrics"
  | "system"
  | "not-found";

export interface RouteDef {
  id: Exclude<RouteId, "not-found">;
  path: string;
  label: string;
}

/** Primary navigation, in display order. */
export const ROUTES: readonly RouteDef[] = [
  { id: "overview", path: "/overview", label: "Overview" },
  { id: "work", path: "/work", label: "Work Queue" },
  { id: "execution", path: "/execution", label: "Execution" },
  { id: "approvals", path: "/approvals", label: "Approvals" },
  { id: "agents", path: "/agents", label: "Agents" },
  { id: "connectors", path: "/connectors", label: "Connectors" },
  { id: "policy", path: "/policy", label: "Policy" },
  { id: "audit", path: "/audit", label: "Audit" },
  { id: "metrics", path: "/metrics", label: "Metrics" },
  { id: "system", path: "/system", label: "System" }
];

export interface Location {
  /** Path relative to BASE_PATH, always starting with "/". */
  path: string;
  search: URLSearchParams;
}

export interface ParsedRoute {
  id: RouteId;
  /** Selected record id, decoded (e.g. /work/WI-1837 → "WI-1837"). */
  param: string | undefined;
}

export function parsePath(path: string): ParsedRoute {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return { id: "overview", param: undefined };
  const route = ROUTES.find((candidate) => candidate.path === `/${segments[0]}`);
  if (!route) return { id: "not-found", param: undefined };
  if (segments.length > 2) return { id: "not-found", param: undefined };
  let param: string | undefined;
  if (segments[1] !== undefined) {
    try {
      param = decodeURIComponent(segments[1]);
    } catch {
      return { id: "not-found", param: undefined };
    }
  }
  return { id: route.id, param };
}

function stripBase(pathname: string): string {
  if (pathname === BASE_PATH) return "/";
  return pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname;
}

function readLocation(): Location {
  return { path: stripBase(window.location.pathname), search: new URLSearchParams(window.location.search) };
}

// A stable snapshot string so useSyncExternalStore does not loop on fresh objects.
const listeners = new Set<() => void>();
function snapshot(): string {
  return `${window.location.pathname}${window.location.search}`;
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = to.startsWith(BASE_PATH) ? to : `${BASE_PATH}${to.startsWith("/") ? to : `/${to}`}`;
  if (url === snapshot()) return;
  if (options.replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  for (const listener of [...listeners]) listener();
}

interface RouterValue {
  location: Location;
  route: ParsedRoute;
  go: (to: string, options?: { replace?: boolean }) => void;
  /** Merge query params into the current URL (filters, tabs) without adding history noise. */
  setSearch: (update: Record<string, string | undefined> | URLSearchParams) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const key = useSyncExternalStore(subscribe, snapshot, snapshot);
  const value = useMemo<RouterValue>(() => {
    const location = readLocation();
    return {
      location,
      route: parsePath(location.path),
      go: navigate,
      setSearch: (update) => {
        const next = new URLSearchParams(update instanceof URLSearchParams ? undefined : window.location.search);
        if (update instanceof URLSearchParams) {
          for (const [k, v] of update) next.set(k, v);
        } else {
          for (const [k, v] of Object.entries(update)) {
            if (v === undefined || v === "") next.delete(k);
            else next.set(k, v);
          }
        }
        const qs = next.toString();
        navigate(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
      }
    };
    // `key` changes whenever pathname or search changes.
  }, [key]);

  // Canonicalise the bare /console entry to /console/overview without a history entry.
  useEffect(() => {
    if (value.location.path === "/" || value.location.path === "") navigate("/overview", { replace: true });
  }, [value.location.path]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter must be used inside <RouterProvider>");
  return value;
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
}

/** Client-side navigation that still renders a real, copyable href and honours modified clicks. */
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const href = to.startsWith(BASE_PATH) ? to : `${BASE_PATH}${to.startsWith("/") ? to : `/${to}`}`;
  const handle = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (rest.target && rest.target !== "_self") return;
      event.preventDefault();
      navigate(href);
    },
    [href, onClick, rest.target]
  );
  return (
    <a {...rest} href={href} onClick={handle}>
      {children}
    </a>
  );
}
