export interface BarPoint {
  label: string;
  value: number;
}

/**
 * Minimal SVG bar chart. Handles zero/sparse input honestly (no synthetic
 * points) and always ships a text alternative: a summary sentence plus a
 * visually-hidden data table.
 */
export function BarChart({
  title,
  points,
  unit = "",
  emptyMessage
}: {
  title: string;
  points: readonly BarPoint[];
  unit?: string;
  emptyMessage: string;
}) {
  if (points.length === 0) {
    return (
      <div className="state" role="status">
        <p>{emptyMessage}</p>
      </div>
    );
  }
  const width = 480;
  const height = 120;
  const pad = 18;
  const max = Math.max(1, ...points.map((p) => p.value));
  const slot = (width - pad * 2) / points.length;
  const barWidth = Math.max(2, Math.min(28, slot - 3));
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const summary = `${title}: ${points.length} samples, total ${total}${unit}, peak ${max}${unit}.`;
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
        <title>{title}</title>
        <line className="axis" x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} />
        {points.map((point, index) => {
          const h = (point.value / max) * (height - pad * 2);
          return (
            <rect
              key={`${point.label}-${index}`}
              className="bar"
              x={pad + index * slot + (slot - barWidth) / 2}
              y={height - pad - h}
              width={barWidth}
              height={Math.max(point.value > 0 ? 1 : 0, h)}
              rx={2}
            >
              <title>{`${point.label}: ${point.value}${unit}`}</title>
            </rect>
          );
        })}
        <text x={pad} y={height - 4}>
          {points[0]?.label}
        </text>
        <text x={width - pad} y={height - 4} textAnchor="end">
          {points[points.length - 1]?.label}
        </text>
        <text x={pad} y={10}>{`peak ${max}${unit}`}</text>
      </svg>
      <figcaption className="visually-hidden">{summary}</figcaption>
      <table className="visually-hidden">
        <caption>{title} data</caption>
        <thead>
          <tr>
            <th scope="col">Sample</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={`${point.label}-${index}`}>
              <td>{point.label}</td>
              <td>{point.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
