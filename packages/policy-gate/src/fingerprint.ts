import { stableHash } from "@agent-control-stack/shared";
import type { ActionRequest } from "@agent-control-stack/work-items";
import type { PolicyContext } from "./policy.js";

export function actionFingerprint(context: PolicyContext): string {
  return stableHash({
    action: context.action,
    command: context.command,
    cwd: context.cwd,
    destructive: context.destructive,
    network: context.network,
    paths: context.paths,
    write: context.write
  });
}

export function actionRequestFingerprint(action: ActionRequest): string {
  return stableHash(action);
}
