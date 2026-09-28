import { stableHash } from "@agent-control-stack/shared";
import { canonicalActionEnvelope } from "./action-envelope.js";
import type { PolicyContext } from "./policy.js";

export function actionFingerprint(context: PolicyContext): string {
  return stableHash(canonicalActionEnvelope(context));
}
