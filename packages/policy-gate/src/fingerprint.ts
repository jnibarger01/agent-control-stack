import { stableHash } from "@agent-control-stack/shared";
import type { PolicyContext } from "./policy.js";

export function actionFingerprint(context: PolicyContext): string {
  return stableHash({
    requester: context.requester,
    risk: context.risk,
    action: {
      kind: context.action.kind,
      description: context.action.description,
      params: context.action.params
    },
    command: context.command,
    cwd: context.cwd,
    destructive: context.destructive,
    network: context.network,
    paths: context.paths,
    write: context.write
  });
}
