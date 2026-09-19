import { useSyncExternalStore } from "react";

export type SessionStatus = "unknown" | "authenticated" | "unauthenticated";

/**
 * Tracks only whether the gateway accepts our session cookie. The cookie is
 * HttpOnly, so no credential is ever visible to (or storable by) this code.
 */
class SessionStore {
  private status: SessionStatus = "unknown";
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): SessionStatus => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(next: SessionStatus): void {
    if (next === this.status) return;
    this.status = next;
    for (const listener of [...this.listeners]) listener();
  }
  markAuthenticated = (): void => this.set("authenticated");
  markUnauthenticated = (): void => this.set("unauthenticated");
}

export const sessionStore = new SessionStore();

export function useSessionStatus(): SessionStatus {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot, sessionStore.getSnapshot);
}
