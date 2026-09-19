import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface Toast {
  id: number;
  tone: "success" | "danger" | "info";
  message: string;
}

const ToastContext = createContext<(tone: Toast["tone"], message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((all) => all.filter((toast) => toast.id !== id));
  }, []);
  const notify = useCallback(
    (tone: Toast["tone"], message: string) => {
      const id = next.current++;
      setToasts((all) => [...all.slice(-3), { id, tone, message }]);
      // Failures stay until dismissed so they cannot be missed.
      if (tone !== "danger")
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), 6000)
        );
    },
    [dismiss]
  );
  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);
  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="toast"
            data-tone={toast.tone}
            role={toast.tone === "danger" ? "alert" : "status"}
          >
            <div className="row-between">
              <span>{toast.message}</span>
              <button
                type="button"
                className="btn"
                data-size="sm"
                data-variant="ghost"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
