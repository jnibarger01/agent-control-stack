/**
 * The recorder stays off unless an operator turns it on.
 * Importing this package does not record, authorize, or dispatch anything.
 */
export function recorderFeatureEnabled(env: NodeJS.ProcessEnv = typeof process === "undefined" ? {} : process.env): boolean {
  return env.ABBR_ENABLED === "1";
}
