import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { describeError } from "../api/errors";

/**
 * Runs one async mutation at a time. The in-flight flag is a ref, not state,
 * so two clicks inside the same frame cannot both pass the guard before React
 * re-renders — that is what prevents duplicate submissions.
 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const inflight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (...args: A): Promise<{ ok: true; value: R } | { ok: false; error: unknown } | undefined> => {
      if (inflight.current) return undefined;
      inflight.current = true;
      if (mounted.current) {
        setPending(true);
        setError(undefined);
      }
      try {
        const value = await fn(...args);
        return { ok: true, value };
      } catch (caught) {
        if (mounted.current) setError(caught);
        return { ok: false, error: caught };
      } finally {
        inflight.current = false;
        if (mounted.current) setPending(false);
      }
    },
    [fn]
  );
  const reset = useCallback(() => setError(undefined), []);
  return { run, pending, error, reset };
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Exact resource(s) being acted on; rendered before the confirm button so intent is unambiguous. */
  target: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  variant?: "primary" | "danger" | "success";
  reason?: { label: string; required: boolean; placeholder?: string };
  extra?: ReactNode;
  /** Return normally on backend success; throw the API error to keep the dialog open and show it. */
  onConfirm: (reason: string) => Promise<unknown>;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  target,
  description,
  confirmLabel,
  variant = "primary",
  reason,
  extra,
  onConfirm,
  onClose
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const action = useAction(onConfirm);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    if (!open) {
      setText("");
      setTouched(false);
      action.reset();
    }
  }, [open, action.reset]);

  const reasonMissing = Boolean(reason?.required) && text.trim().length === 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (reasonMissing) return;
    const outcome = await action.run(text.trim());
    if (outcome?.ok) onClose();
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!action.pending) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          {description && <p className="muted">{description}</p>}
          <div className="card" style={{ padding: "var(--space-3)" }}>
            {target}
          </div>
          {extra}
          {reason && (
            <label className="field" htmlFor={reasonId}>
              <span>
                {reason.label}
                {reason.required ? " (required)" : " (optional)"}
              </span>
              <textarea
                id={reasonId}
                className="textarea"
                value={text}
                placeholder={reason.placeholder}
                onChange={(event) => setText(event.target.value)}
                aria-invalid={touched && reasonMissing}
                aria-describedby={touched && reasonMissing ? `${reasonId}-err` : undefined}
                disabled={action.pending}
              />
              {touched && reasonMissing && (
                <span id={`${reasonId}-err`} className="field-error" role="alert">
                  A reason is required and is recorded in the audit log.
                </span>
              )}
            </label>
          )}
          {action.error !== undefined && (
            <div className="banner" data-tone="danger" role="alert">
              <div>
                <strong>Not completed</strong>
                <p>{describeError(action.error)}</p>
              </div>
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose} disabled={action.pending}>
            Cancel
          </button>
          <button type="submit" className="btn" data-variant={variant} disabled={action.pending}>
            {action.pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
