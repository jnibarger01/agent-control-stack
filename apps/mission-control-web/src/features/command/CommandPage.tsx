import type { OverviewReadModel } from "@agent-control-stack/mission-control-contract";
import { AgentNetwork } from "./AgentNetwork";
import { Activity, InfrastructureStrip, KpiRow, NeedsYou, Observability, Pipeline, Readiness } from "./sections";

export function CommandPage({ data }: { data: OverviewReadModel; stale: boolean }) {
  return (
    <div className="space-y-6">
      <NeedsYou data={data} />
      <KpiRow data={data} />
      <AgentNetwork data={data} />
      <Pipeline data={data} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Observability data={data} />
        <Readiness data={data} />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Activity data={data} />
        <InfrastructureStrip data={data} />
      </div>
    </div>
  );
}
