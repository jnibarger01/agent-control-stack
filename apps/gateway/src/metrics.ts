function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class GatewayMetrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; sumSeconds: number }>();
  private sqliteReady = 0;

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observeRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    this.increment("acs_http_requests_total", { method, route, status: String(statusCode) });
    const key = metricKey("acs_http_request_duration_seconds", { method, route });
    const current = this.durations.get(key) ?? { count: 0, sumSeconds: 0 };
    current.count += 1;
    current.sumSeconds += Math.max(0, durationMs) / 1_000;
    this.durations.set(key, current);
  }

  setSqliteReady(ready: boolean): void {
    this.sqliteReady = ready ? 1 : 0;
  }

  render(): string {
    const lines = [
      "# HELP acs_sqlite_ready Whether the SQLite control plane passed its latest health check.",
      "# TYPE acs_sqlite_ready gauge",
      `acs_sqlite_ready ${this.sqliteReady}`
    ];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.durations) {
      lines.push(`${metricSuffix(key, "_count")} ${value.count}`);
      lines.push(`${metricSuffix(key, "_sum")} ${value.sumSeconds}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([key, value]) => `${key}="${label(value)}"`).join(",")}}`;
}

function metricSuffix(key: string, suffix: string): string {
  const labelsStart = key.indexOf("{");
  return labelsStart === -1 ? `${key}${suffix}` : `${key.slice(0, labelsStart)}${suffix}${key.slice(labelsStart)}`;
}
