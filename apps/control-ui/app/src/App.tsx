import { lazy, Suspense, useEffect, type ReactElement } from "react";
import { RouterProvider, useRouter } from "./router";
import { endpoints } from "./api/endpoints";
import { useQuery } from "./state/query";
import { useSessionStatus } from "./state/session";
import { eventStream } from "./state/data";
import { Shell } from "./components/Shell";
import { Login } from "./components/Login";
import { ToastProvider } from "./components/Toasts";
import { ErrorState, LoadingState } from "./components/ui";
import { OverviewPage } from "./routes/OverviewPage";
import { NotFound } from "./routes/NotFound";

// Heavier or rarely-first views are split out of the entry bundle.
const WorkPage = lazy(() => import("./routes/WorkPage").then((m) => ({ default: m.WorkPage })));
const ExecutionPage = lazy(() => import("./routes/ExecutionPage").then((m) => ({ default: m.ExecutionPage })));
const ApprovalsPage = lazy(() => import("./routes/ApprovalsPage").then((m) => ({ default: m.ApprovalsPage })));
const AgentsPage = lazy(() => import("./routes/AgentsPage").then((m) => ({ default: m.AgentsPage })));
const ConnectorsPage = lazy(() => import("./routes/ConnectorsPage").then((m) => ({ default: m.ConnectorsPage })));
const PolicyPage = lazy(() => import("./routes/PolicyPage").then((m) => ({ default: m.PolicyPage })));
const AuditPage = lazy(() => import("./routes/AuditPage").then((m) => ({ default: m.AuditPage })));
const MetricsPage = lazy(() => import("./routes/MetricsPage").then((m) => ({ default: m.MetricsPage })));
const SystemPage = lazy(() => import("./routes/SystemPage").then((m) => ({ default: m.SystemPage })));

function RouteView(): ReactElement {
  const { route } = useRouter();
  switch (route.id) {
    case "overview":
      return <OverviewPage />;
    case "work":
      return <WorkPage />;
    case "execution":
      return <ExecutionPage />;
    case "approvals":
      return <ApprovalsPage />;
    case "agents":
      return <AgentsPage />;
    case "connectors":
      return <ConnectorsPage />;
    case "policy":
      return <PolicyPage />;
    case "audit":
      return <AuditPage />;
    case "metrics":
      return <MetricsPage />;
    case "system":
      return <SystemPage />;
    default:
      return <NotFound />;
  }
}

function Authenticated() {
  // The live stream exists exactly as long as an authenticated shell is mounted. It is also
  // released when the page is hidden for navigation or the back/forward cache: a browser
  // allows ~6 HTTP/1.1 connections per origin, so a leaked stream from a frozen document
  // would starve every other request. It is re-established on restore.
  useEffect(() => {
    eventStream.start();
    const onHide = () => eventStream.stop();
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) eventStream.start();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      eventStream.stop();
    };
  }, []);
  return (
    <Shell>
      <Suspense fallback={<LoadingState />}>
        <RouteView />
      </Suspense>
    </Shell>
  );
}

function SessionGate() {
  const status = useSessionStatus();
  // A cheap authenticated read decides whether the cookie is still valid on first load and after refresh.
  const probe = useQuery("session-probe", (signal) => endpoints.listEvents({ limit: 1 }, signal), {
    enabled: status === "unknown"
  });
  if (status === "unauthenticated") return <Login />;
  if (status === "unknown") {
    if (probe.error && !probe.isFetching) {
      return (
        <main className="login" id="main-content">
          <ErrorState error={probe.error} onRetry={probe.refetch} what="the ACS gateway" />
        </main>
      );
    }
    return (
      <main className="login" id="main-content">
        <LoadingState label="Connecting to ACS…" />
      </main>
    );
  }
  return <Authenticated />;
}

export function App() {
  return (
    <RouterProvider>
      <ToastProvider>
        <SessionGate />
      </ToastProvider>
    </RouterProvider>
  );
}
