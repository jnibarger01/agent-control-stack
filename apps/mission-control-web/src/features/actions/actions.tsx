import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { postWorkItemAction, type ActionKind } from "../../data/api";
import { ROOT_KEY, useStreamState } from "../../data/live";
import { shortId } from "../../design/format";
import { StatusPill } from "../../design/primitives";

export interface ActionSpec {
  kind: ActionKind;
  workItemId: string;
  title: string;
  risk: string;
  /** Policy action fingerprint; required to approve one bounded action. */
  actionHash?: string;
  actionKind?: string;
  /** What the gated action does, in the policy's words. Shown so approval is informed. */
  actionDescription?: string;
  requester?: string;
  intent?: string;
}

interface Copy { verb: string; heading: string; dismiss: string; reasonRequired: boolean; reasonLabel: string; done: string; danger: boolean }
export const ACTION_COPY: Record<ActionKind, Copy> = {
  approve: { verb: "Approve", heading: "Approve this action?", dismiss: "Cancel", reasonRequired: true, reasonLabel: "Reason for approving", done: "approved", danger: false },
  deny: { verb: "Deny", heading: "Deny this work item?", dismiss: "Cancel", reasonRequired: true, reasonLabel: "Reason for denying", done: "denied", danger: true },
  unblock: { verb: "Unblock", heading: "Unblock this work item?", dismiss: "Go back", reasonRequired: false, reasonLabel: "", done: "unblocked", danger: false },
  cancel: { verb: "Cancel work item", heading: "Cancel this work item?", dismiss: "Keep work item", reasonRequired: true, reasonLabel: "Reason for cancelling", done: "cancelled", danger: true },
  retry: { verb: "Retry as new item", heading: "Retry this work item as a new item?", dismiss: "Go back", reasonRequired: true, reasonLabel: "Reason for retrying", done: "retried as a new item", danger: false }
};

function outcomeMessage(spec: ActionSpec, copy: Copy, workItemStatus: string | undefined): string {
  if (spec.kind === "approve" && workItemStatus && workItemStatus !== "approved") {
    return `Approval recorded for “${spec.title}”, but it still needs more approvals (status: ${workItemStatus.replace(/_/g, " ")}).`;
  }
  return `“${spec.title}” ${copy.done}.`;
}

/**
 * Confirmation is mandatory for every action (stricter than the classic console, which only
 * confirms elevated risk for approve/deny). Initial focus is on the safe choice, Escape dismisses,
 * and the confirm button is disabled until a reason is given and while a request is in flight.
 */
export function ConfirmDialog({ spec, onClose, onDone }: { spec: ActionSpec; onClose: () => void; onDone: (message: string) => void }) {
  const copy = ACTION_COPY[spec.kind];
  const stream = useStreamState();
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const valid = !copy.reasonRequired || reason.trim().length > 0;
  const live = stream === "live";
  const canConfirm = valid && live && !pending && (spec.kind !== "approve" || Boolean(spec.actionHash));

  const confirm = useCallback(async () => {
    if (inFlight.current || !canConfirm) return;
    inFlight.current = true; // one request per confirmation, even on double click
    setPending(true);
    setError(null);
    const result = await postWorkItemAction(spec.kind, spec.workItemId, { reason: reason.trim(), ...(spec.actionHash ? { actionHash: spec.actionHash } : {}) });
    if (result.ok) {
      // Stay locked after success: the dialog closes immediately and must never allow a second POST
      // (a retry would otherwise create another work item). Refresh in the background.
      void client.invalidateQueries({ queryKey: ROOT_KEY });
      onDone(outcomeMessage(spec, copy, result.workItemStatus));
    } else {
      inFlight.current = false;
      setPending(false);
      setError(result.message);
    }
  }, [canConfirm, client, copy.done, onDone, reason, spec]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onKeyDown={(e) => e.key === "Escape" && !pending && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="acs-in w-full max-w-md rounded-card border border-line-strong bg-surface p-6 shadow-2xl">
        <h2 id={titleId} className="text-lg font-semibold">{copy.heading}</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-muted">Work item</dt><dd className="text-right font-medium">{spec.title}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted">Identifier</dt><dd className="font-mono text-xs">{shortId(spec.workItemId, 12)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted">Risk</dt><dd><StatusPill tone={spec.risk === "high" || spec.risk === "critical" ? "bad" : spec.risk === "medium" ? "warn" : "neutral"} glyph="◆">{spec.risk}</StatusPill></dd></div>
          {spec.requester && <div className="flex justify-between gap-3"><dt className="text-muted">Requested by</dt><dd className="text-right">{spec.requester}</dd></div>}
          {spec.actionKind && <div className="flex justify-between gap-3"><dt className="text-muted">Action</dt><dd className="text-right font-mono text-xs">{spec.actionKind}</dd></div>}
        </dl>
        {spec.intent && <p className="mt-3 rounded-ctl bg-surface-2 px-3 py-2 text-sm"><span className="block text-xs text-muted">Stated intent</span>{spec.intent}</p>}
        {spec.actionDescription && <p className="mt-2 rounded-ctl bg-surface-2 px-3 py-2 text-sm"><span className="block text-xs text-muted">What this action does</span>{spec.actionDescription}</p>}
        {spec.actionHash && <p className="mt-2 text-xs text-muted">Action hash <code className="select-all break-all font-mono text-ink">{spec.actionHash}</code></p>}
        {copy.reasonRequired && (
          <label className="mt-4 block text-sm">
            <span className="text-muted">{copy.reasonLabel}</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} disabled={pending} required aria-required="true" className="mt-1 w-full rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm text-ink" />
          </label>
        )}
        {!live && <p role="alert" className="mt-3 text-sm text-warn">The live stream is disconnected, so this action is disabled until the connection recovers.</p>}
        {error && <p role="alert" className="mt-3 rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-bad">The gateway refused this action: {error}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button ref={cancelRef} type="button" onClick={onClose} disabled={pending} className="rounded-ctl border border-line px-4 py-2 text-sm text-muted hover:text-ink">{copy.dismiss}</button>
          <button type="button" onClick={() => void confirm()} disabled={!canConfirm} className={`rounded-ctl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${copy.danger ? "bg-bad text-white" : "bg-accent text-accent-ink"}`}>{pending ? "Sending…" : copy.verb}</button>
        </div>
      </div>
    </div>
  );
}

/** Opens the confirm dialog and renders the outcome notice. Pages render `element` once. */
export function useWorkItemActions(): { open: (spec: ActionSpec) => void; element: ReactNode } {
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const [notice, setNotice] = useState("");
  const open = useCallback((next: ActionSpec) => { setNotice(""); setSpec(next); }, []);
  const element = (
    <>
      <div role="status" aria-live="polite" className={notice ? "mb-4 rounded-ctl border border-ok/40 bg-ok-soft px-4 py-2 text-sm text-ok" : "sr-only"}>{notice}</div>
      {spec && <ConfirmDialog spec={spec} onClose={() => setSpec(null)} onDone={(m) => { setSpec(null); setNotice(m); }} />}
    </>
  );
  return { open, element };
}

/** Why a control is unavailable, never silently hidden. */
export function useControlGate(allowed: boolean, what: "approve" | "write"): { disabled: boolean; why: string | null } {
  const stream = useStreamState();
  if (!allowed) return { disabled: true, why: what === "approve" ? "Your credential does not have approval permission." : "Your credential does not have write permission." };
  if (stream !== "live") return { disabled: true, why: "Live stream disconnected; controls are disabled until it recovers." };
  return { disabled: false, why: null };
}
