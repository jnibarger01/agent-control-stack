/** Off unless the Mission Control build was started with VITE_ABBR_ENABLED=1. */
export function abbrUiEnabled(): boolean {
  const env = import.meta.env as { VITE_ABBR_ENABLED?: string };
  return env.VITE_ABBR_ENABLED === "1";
}
