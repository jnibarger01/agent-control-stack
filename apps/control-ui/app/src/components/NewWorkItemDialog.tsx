import { useId, useState } from "react";
import { endpoints } from "../api/endpoints";
import { navigate } from "../router";
import { keys } from "../state/reconcile";
import { queryCache } from "../state/query";
import { ConfirmDialog } from "./Dialog";
import { useToast } from "./Toasts";

const RISKS = ["low", "medium", "high", "critical"] as const;

/**
 * Creates a governed work item through POST /work-items. The gateway derives
 * requester and requester subject from the session credential and runs the
 * policy gate: the created item may land in needs_approval or blocked, and this
 * dialog reports whatever status ACS assigns rather than assuming success.
 */
export function NewWorkItemDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const base = useId();
  const [form, setForm] = useState({
    title: "",
    intent: "",
    risk: "medium",
    cwd: "",
    kind: "",
    description: "",
    params: ""
  });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const reset = () =>
    setForm({ title: "", intent: "", risk: "medium", cwd: "", kind: "", description: "", params: "" });

  return (
    <ConfirmDialog
      open={open}
      title="New work item"
      confirmLabel="Create work item"
      variant="primary"
      description="Creates a governed work item. Policy decides whether it runs, needs approval, or is blocked."
      target={<span className="muted">Requester is set by the gateway from your session.</span>}
      extra={
        <div className="stack">
          <label className="field" htmlFor={`${base}-title`}>
            <span>Title (required)</span>
            <input
              id={`${base}-title`}
              className="input"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
            />
          </label>
          <label className="field" htmlFor={`${base}-intent`}>
            <span>Intent (required)</span>
            <textarea
              id={`${base}-intent`}
              className="textarea"
              value={form.intent}
              onChange={(e) => set("intent", e.target.value)}
            />
          </label>
          <div className="row">
            <label className="field" htmlFor={`${base}-risk`}>
              <span>Risk</span>
              <select
                id={`${base}-risk`}
                className="select"
                value={form.risk}
                onChange={(e) => set("risk", e.target.value)}
              >
                {RISKS.map((risk) => (
                  <option key={risk}>{risk}</option>
                ))}
              </select>
            </label>
            <label className="field" htmlFor={`${base}-cwd`} style={{ flex: 1 }}>
              <span>Target working directory</span>
              <input
                id={`${base}-cwd`}
                className="input"
                value={form.cwd}
                onChange={(e) => set("cwd", e.target.value)}
              />
            </label>
          </div>
          <label className="field" htmlFor={`${base}-kind`}>
            <span>Action kind (required)</span>
            <input
              id={`${base}-kind`}
              className="input"
              placeholder="e.g. fs.write, system.status"
              value={form.kind}
              onChange={(e) => set("kind", e.target.value)}
            />
          </label>
          <label className="field" htmlFor={`${base}-desc`}>
            <span>Action description (required)</span>
            <input
              id={`${base}-desc`}
              className="input"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </label>
          <label className="field" htmlFor={`${base}-params`}>
            <span>Action parameters (JSON object, optional)</span>
            <textarea
              id={`${base}-params`}
              className="textarea"
              value={form.params}
              onChange={(e) => set("params", e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
      }
      onConfirm={async () => {
        if (!form.title.trim() || !form.intent.trim() || !form.kind.trim() || !form.description.trim()) {
          throw new Error("Title, intent, action kind and action description are required.");
        }
        let params: Record<string, unknown> = {};
        if (form.params.trim()) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(form.params);
          } catch {
            throw new Error("Action parameters must be valid JSON.");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Action parameters must be a JSON object.");
          params = parsed as Record<string, unknown>;
        }
        const created = await endpoints.createWorkItem({
          title: form.title.trim(),
          intent: form.intent.trim(),
          risk: form.risk,
          target: form.cwd.trim() ? { cwd: form.cwd.trim() } : {},
          requestedActions: [{ kind: form.kind.trim(), description: form.description.trim(), params }]
        });
        queryCache.invalidate(keys.workItems);
        queryCache.invalidate(keys.events);
        toast("success", `Created ${created.id}: ACS set status “${created.status}”.`);
        reset();
        navigate(`/work/${encodeURIComponent(created.id)}`);
      }}
      onClose={onClose}
    />
  );
}
