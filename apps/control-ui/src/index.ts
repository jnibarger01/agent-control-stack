import type { WorkItem } from "@agent-control-stack/work-items";

export function renderDashboard(workItems: WorkItem[]): string {
  const rows = workItems.map(renderRow).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Control Stack</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; background: #f7f8fb; color: #16181d; }
      main { max-width: 1120px; margin: 0 auto; padding: 32px 20px; }
      h1 { font-size: 28px; margin: 0 0 12px; }
      .notice, table { width: 100%; background: #fff; border: 1px solid #d9dee8; border-radius: 8px; }
      .notice { box-sizing: border-box; padding: 14px 16px; margin: 0 0 20px; color: #344054; }
      table { border-collapse: collapse; overflow: hidden; }
      th, td { padding: 12px; border-bottom: 1px solid #e6eaf0; text-align: left; vertical-align: top; }
      th { font-size: 12px; color: #526071; text-transform: uppercase; }
      tr:last-child td { border-bottom: 0; }
      .status { font-weight: 700; }
      .meta, .empty { color: #667085; }
      code { background: #eef2f7; border-radius: 4px; padding: 1px 4px; }
      @media (max-width: 860px) { table { font-size: 14px; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent Control Stack</h1>
      <p class="notice">Dashboard is read-only until session auth and CSRF protection exist. Mutations require the authenticated HTTP API.</p>
      <table>
        <thead>
          <tr><th>Work item</th><th>Risk</th><th>Status</th><th>Requested actions</th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">No work items.</td></tr>`}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

function renderRow(workItem: WorkItem): string {
  const target = [workItem.target.cwd, ...(workItem.target.files ?? [])].filter(Boolean).join(", ");
  const actions = workItem.requestedActions.map(renderAction).join("<br />") || "—";

  return `<tr>
    <td>
      <strong>${escapeHtml(workItem.title)}</strong>
      <div>${escapeHtml(workItem.intent)}</div>
      <div class="meta">${escapeHtml(workItem.requester)}${target ? ` · ${escapeHtml(target)}` : ""}</div>
    </td>
    <td>${escapeHtml(workItem.risk)}</td>
    <td class="status">${escapeHtml(workItem.status)}</td>
    <td>${actions}</td>
  </tr>`;
}

function renderAction(action: WorkItem["requestedActions"][number]): string {
  return `<code>${escapeHtml(action.kind)}</code> ${escapeHtml(action.description)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return escapes[char] ?? char;
  });
}
