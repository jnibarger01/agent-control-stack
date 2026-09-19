import { keys } from "./reconcile";
import { queryCache } from "./query";

/** After a connector mutation the audit-derived views are re-read from the gateway; nothing is patched locally. */
export function refreshConnectors(_connectorId: string): void {
  queryCache.invalidate(`${keys.events}:ledger`);
  queryCache.invalidate(keys.actors);
  queryCache.invalidate(keys.agents);
  queryCache.invalidate(keys.connectors);
}
