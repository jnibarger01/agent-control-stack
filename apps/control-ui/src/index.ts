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
      h1 { font-size: 28px; margin: 0 0 24px; }
      form, table { width: 100%; background: #fff; border: 1px solid #d9dee8; border-radius: 8px; }
      form { display: grid; grid-template-columns: 1fr 1.5fr 120px 120px 120px; gap: 12px; padding: 16px; margin-bottom: 20px; }
      input, select, button { min-height: 38px; font: inherit; border-radius: 6px; border: 1px solid #c7cfda; padding: 0 10px; }
      button { cursor: pointer; background: #1f6feb; color: #fff; border-color: #1f6feb; font-weight: 650; }
      button.secondary { background: #fff; color: #344054; border-color: #c7cfda; }
      table { border-collapse: collapse; overflow: hidden; }
      th, td { padding: 12px; border-bottom: 1px solid #e6eaf0; text-align: left; vertical-align: top; }
      th { font-size: 12px; color: #526071; text-transform: uppercase; }
      tr:last-child td { border-bottom: 0; }
      .status { font-weight: 700; }
      .meta, .empty { color: #667085; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      @media (max-width: 860px) { form { grid-template-columns: 1fr; } table { font-size: 14px; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent Control Stack</h1>
      <form id="create-form">
        <input name="title" placeholder="Title" required />
        <input name="intent" placeholder="Intent" required />
        <select name="requester">
          <option value="user" selected>User</option>
          <option value="agent">Agent</option>
          <option value="system">System</option>
        </select>
        <select name="risk">
          <option value="low">Low risk</option>
          <option value="medium" selected>Medium risk</option>
          <option value="high">High risk</option>
          <option value="critical">Critical risk</option>
        </select>
        <button type="submit">Create</button>
      </form>
      <table>
        <thead>
          <tr><th>Work item</th><th>Risk</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">No work items.</td></tr>`}</tbody>
      </table>
    </main>
    <script type="module">
      document.querySelector("#create-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const intent = String(form.get("intent"));
        await fetch("/work-items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: form.get("title"),
            requester: form.get("requester"),
            intent,
            risk: form.get("risk"),
            requestedActions: [{ kind: "manual", description: intent }]
          })
        });
        location.reload();
      });

      document.querySelectorAll("[data-approve]").forEach((button) => {
        button.addEventListener("click", async () => {
          await fetch("/work-items/" + button.dataset.approve + "/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approvedBy: "control-ui", reason: "dashboard approval" })
          });
          location.reload();
        });
      });

      document.querySelectorAll("[data-cancel]").forEach((button) => {
        button.addEventListener("click", async () => {
          await fetch("/work-items/" + button.dataset.cancel + "/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "dashboard cancellation" })
          });
          location.reload();
        });
      });
    </script>
  </body>
</html>`;
}

function renderRow(workItem: WorkItem): string {
  const canApprove = workItem.status === "pending_policy" || workItem.status === "needs_approval";
  const canCancel = !["succeeded", "failed", "cancelled"].includes(workItem.status);
  const target = [workItem.target.cwd, ...(workItem.target.files ?? [])].filter(Boolean).join(", ");

  return `<tr>
    <td>
      <strong>${escapeHtml(workItem.title)}</strong>
      <div>${escapeHtml(workItem.intent)}</div>
      <div class="meta">${escapeHtml(workItem.requester)}${target ? ` · ${escapeHtml(target)}` : ""}</div>
    </td>
    <td>${escapeHtml(workItem.risk)}</td>
    <td class="status">${escapeHtml(workItem.status)}</td>
    <td><div class="actions">${canApprove ? approveButton(workItem.id) : ""}${canCancel ? cancelButton(workItem.id) : ""}</div></td>
  </tr>`;
}

function approveButton(id: string): string {
  return `<button type="button" data-approve="${escapeHtml(id)}">Approve</button>`;
}

function cancelButton(id: string): string {
  return `<button class="secondary" type="button" data-cancel="${escapeHtml(id)}">Cancel</button>`;
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
