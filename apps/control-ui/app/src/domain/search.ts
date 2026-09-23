import type { ProjectedActor, RegistryAgentView, WorkItem } from "../api/types";

export type SearchKind = "work" | "agent" | "connector" | "execution";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export interface SearchIndexInput {
  workItems: readonly WorkItem[];
  registryAgents: readonly RegistryAgentView[];
  actors: readonly ProjectedActor[];
  attemptIds?: ReadonlyArray<{ attemptId: string; workItemId: string }>;
}

/**
 * The gateway has no global-search endpoint. Search runs client-side over the
 * datasets this tab has already loaded; the palette says so explicitly.
 */
export function searchIndex(input: SearchIndexInput, query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<SearchHit & { score: number }> = [];
  const score = (text: string, id: string): number => {
    const t = text.toLowerCase();
    if (id.toLowerCase() === q) return 100;
    if (id.toLowerCase().startsWith(q)) return 80;
    if (t.startsWith(q)) return 60;
    if (t.includes(q)) return 40;
    return 0;
  };
  for (const item of input.workItems) {
    const s = Math.max(score(item.id, item.id), score(item.title, item.id));
    if (s)
      hits.push({
        kind: "work",
        id: item.id,
        title: item.title,
        subtitle: `${item.id} · ${item.status}`,
        href: `/work/${encodeURIComponent(item.id)}`,
        score: s
      });
  }
  for (const agent of input.registryAgents) {
    const s = Math.max(score(agent.id, agent.id), score(agent.name, agent.id));
    if (s)
      hits.push({
        kind: "agent",
        id: agent.id,
        title: agent.name,
        subtitle: `${agent.id} · ${agent.kind}`,
        href: `/agents/${encodeURIComponent(agent.id)}`,
        score: s
      });
  }
  for (const actor of input.actors) {
    if (actor.kind !== "connector" && actor.kind !== "tunnel") continue;
    const s = Math.max(score(actor.id, actor.id), score(actor.displayName, actor.id));
    if (s)
      hits.push({
        kind: "connector",
        id: actor.id,
        title: actor.displayName,
        subtitle: `${actor.id} · ${actor.kind}`,
        href: `/connectors/${encodeURIComponent(actor.id)}`,
        score: s
      });
  }
  for (const attempt of input.attemptIds ?? []) {
    const s = score(attempt.attemptId, attempt.attemptId);
    if (s)
      hits.push({
        kind: "execution",
        id: attempt.attemptId,
        title: attempt.attemptId,
        subtitle: `attempt · ${attempt.workItemId}`,
        href: `/execution/${encodeURIComponent(attempt.workItemId)}`,
        score: s
      });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit);
}
