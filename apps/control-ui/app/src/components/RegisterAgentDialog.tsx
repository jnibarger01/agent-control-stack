import { useId, useState } from "react";
import { endpoints } from "../api/endpoints";
import { keys } from "../state/reconcile";
import { queryCache } from "../state/query";
import { ConfirmDialog } from "./Dialog";
import { useToast } from "./Toasts";

const ACP_ROLES = [
  "IMPLEMENTATION_AGENT",
  "REVIEW_PLANNING_AGENT",
  "RESEARCH_BROAD_SCAN_AGENT",
  "LOCAL_CODING_AGENT",
  "ORCHESTRATION_LAYER",
  "DESKTOP_LOCAL_AGENT_BRIDGE"
];

/** POST /api/agents. Registration only records the agent; liveness still requires real heartbeats. */
export function RegisterAgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const base = useId();
  const [form, setForm] = useState({ id: "", name: "", kind: "llm", acpRole: ACP_ROLES[3]!, provider: "", model: "" });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <ConfirmDialog
      open={open}
      title="Register agent"
      confirmLabel="Register agent"
      description="Registering does not make the agent online: it only appears online after it reports heartbeats."
      target={<span className="muted">The registering actor is taken from your session.</span>}
      extra={
        <div className="stack">
          <label className="field" htmlFor={`${base}-id`}>
            <span>Agent ID (required)</span>
            <input id={`${base}-id`} className="input" value={form.id} onChange={(e) => set("id", e.target.value)} />
          </label>
          <label className="field" htmlFor={`${base}-name`}>
            <span>Display name (required)</span>
            <input
              id={`${base}-name`}
              className="input"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <div className="row">
            <label className="field" htmlFor={`${base}-kind`}>
              <span>Kind</span>
              <input
                id={`${base}-kind`}
                className="input"
                value={form.kind}
                onChange={(e) => set("kind", e.target.value)}
              />
            </label>
            <label className="field" htmlFor={`${base}-role`} style={{ flex: 1 }}>
              <span>ACP role</span>
              <select
                id={`${base}-role`}
                className="select"
                value={form.acpRole}
                onChange={(e) => set("acpRole", e.target.value)}
              >
                {ACP_ROLES.map((role) => (
                  <option key={role}>{role}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field" htmlFor={`${base}-provider`}>
              <span>Provider (optional)</span>
              <input
                id={`${base}-provider`}
                className="input"
                value={form.provider}
                onChange={(e) => set("provider", e.target.value)}
              />
            </label>
            <label className="field" htmlFor={`${base}-model`}>
              <span>Model (optional)</span>
              <input
                id={`${base}-model`}
                className="input"
                value={form.model}
                onChange={(e) => set("model", e.target.value)}
              />
            </label>
          </div>
        </div>
      }
      onConfirm={async () => {
        if (!form.id.trim() || !form.name.trim() || !form.kind.trim())
          throw new Error("Agent ID, display name and kind are required.");
        await endpoints.registerAgent({
          id: form.id.trim(),
          name: form.name.trim(),
          kind: form.kind.trim(),
          acpRole: form.acpRole,
          ...(form.provider.trim() ? { provider: form.provider.trim() } : {}),
          ...(form.model.trim() ? { model: form.model.trim() } : {})
        });
        queryCache.invalidate(keys.agents);
        queryCache.invalidate(keys.actors);
        toast("success", `Registered agent ${form.id.trim()}.`);
        setForm({ id: "", name: "", kind: "llm", acpRole: ACP_ROLES[3]!, provider: "", model: "" });
      }}
      onClose={onClose}
    />
  );
}
