export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parser for the gateway's Prometheus text exposition (apps/gateway/src/metrics.ts).
 * The gateway has no JSON metrics contract, so this is the real, authoritative
 * source. Unparseable lines are skipped rather than guessed at.
 */
export function parsePrometheus(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(-?[0-9.eE+-]+|NaN|\+Inf|-Inf)$/u.exec(line);
    if (!match) continue;
    const value = Number(match[4]);
    if (!Number.isFinite(value)) continue;
    samples.push({ name: match[1]!, labels: parseLabels(match[3] ?? ""), value });
  }
  return samples;
}

function parseLabels(source: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    labels[m[1]!] = m[2]!.replace(/\\n/gu, "\n").replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
  }
  return labels;
}

export function sumWhere(
  samples: readonly MetricSample[],
  name: string,
  predicate: (labels: Record<string, string>) => boolean = () => true
): number {
  return samples.filter((s) => s.name === name && predicate(s.labels)).reduce((total, s) => total + s.value, 0);
}

export interface GatewayMetricSummary {
  sqliteReady: boolean | undefined;
  requestsTotal: number;
  requests429: number;
  requests5xx: number;
  rateLimitRejected: number;
  auditEventsTotal: number;
  sseDropped: number;
  sseRejected: number;
  avgLatencySeconds: number | undefined;
  approvalsGranted: number;
  approvalsConsumed: number;
  needsApprovalEvents: number;
  leasesRenewed: number;
  leasesExpired: number;
  attemptsCreated: number;
  executionsSucceeded: number;
  executionsFailed: number;
  topRoutes: Array<{ route: string; count: number }>;
}

export function summarizeMetrics(samples: readonly MetricSample[]): GatewayMetricSummary {
  const audit = (name: string) => sumWhere(samples, "acs_audit_events_total", (l) => l.event_name === name);
  const count = sumWhere(samples, "acs_http_request_duration_seconds_count");
  const sum = sumWhere(samples, "acs_http_request_duration_seconds_sum");
  const byRoute = new Map<string, number>();
  for (const s of samples) {
    if (s.name !== "acs_http_requests_total") continue;
    const route = s.labels.route ?? "<unmatched>";
    byRoute.set(route, (byRoute.get(route) ?? 0) + s.value);
  }
  const sqlite = samples.find((s) => s.name === "acs_sqlite_ready");
  return {
    sqliteReady: sqlite ? sqlite.value === 1 : undefined,
    requestsTotal: sumWhere(samples, "acs_http_requests_total"),
    requests429: sumWhere(samples, "acs_http_requests_total", (l) => l.status === "429"),
    requests5xx: sumWhere(samples, "acs_http_requests_total", (l) => /^5/u.test(l.status ?? "")),
    rateLimitRejected: sumWhere(samples, "acs_rate_limit_rejected_total"),
    auditEventsTotal: sumWhere(samples, "acs_audit_events_total"),
    sseDropped: sumWhere(samples, "acs_sse_clients_dropped_total"),
    sseRejected: sumWhere(samples, "acs_sse_connections_rejected_total"),
    avgLatencySeconds: count > 0 ? sum / count : undefined,
    approvalsGranted: audit("approval.granted"),
    approvalsConsumed: audit("approval.consumed"),
    needsApprovalEvents: audit("work_item.needs_approval"),
    leasesRenewed: audit("attempt_lease.renewed"),
    leasesExpired: audit("attempt_lease.expired"),
    attemptsCreated: audit("execution_attempt.created"),
    executionsSucceeded: audit("execution.completed"),
    executionsFailed: audit("work_item.failed"),
    topRoutes: [...byRoute.entries()]
      .map(([route, c]) => ({ route, count: c }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
  };
}

/** A sample of a cumulative counter taken by this browser tab (no server-side history exists). */
export interface CounterPoint {
  at: number;
  value: number;
}

/** Per-interval increase between consecutive samples; a counter reset (gateway restart) yields no bar, not a negative one. */
export function counterDeltas(points: readonly CounterPoint[]): Array<{ at: number; delta: number }> {
  const out: Array<{ at: number; delta: number }> = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (cur.value < prev.value) continue;
    out.push({ at: cur.at, delta: cur.value - prev.value });
  }
  return out;
}
