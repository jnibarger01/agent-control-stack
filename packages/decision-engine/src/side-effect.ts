export const SIDE_EFFECT_CLASSES = [
  "READ",
  "LOCAL_WRITE",
  "EXTERNAL_WRITE",
  "SEND",
  "PUBLISH",
  "PAYMENT",
  "DELETE",
  "SECURITY_CHANGE",
  "PRODUCTION_CHANGE"
] as const;

export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

const KIND_CLASS: Readonly<Record<string, SideEffectClass>> = {
  "git.status": "READ",
  "git.diff": "READ",
  "git.log": "READ",
  "git.commit": "LOCAL_WRITE",
  "git.push": "EXTERNAL_WRITE",
  "fs.read": "READ",
  "fs.write": "LOCAL_WRITE",
  "fs.delete": "DELETE",
  deploy: "PRODUCTION_CHANGE",
  restart: "PRODUCTION_CHANGE",
  "http.post": "SEND",
  publish: "PUBLISH",
  payment: "PAYMENT",
  "policy.change": "SECURITY_CHANGE"
};

/** Code classifies the tool. An unknown kind stays unknown; the model cannot invent a class. */
export function classifySideEffect(kind: string): SideEffectClass | null {
  return KIND_CLASS[kind] ?? null;
}

export const CAPABILITY_FOR_CLASS: Readonly<Record<SideEffectClass, string | null>> = {
  READ: null,
  LOCAL_WRITE: "fs:write",
  EXTERNAL_WRITE: "git:write",
  SEND: "net:send",
  PUBLISH: "publish",
  PAYMENT: "payment",
  DELETE: "fs:delete",
  SECURITY_CHANGE: "security:change",
  PRODUCTION_CHANGE: "production:change"
};
