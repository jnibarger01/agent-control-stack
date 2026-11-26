/**
 * Strict application/x-www-form-urlencoded parsing for approval decisions.
 *
 * RFC 6749 section 3.2: a parameter MUST NOT be included more than once. `Object.fromEntries(new URLSearchParams(...))`
 * silently keeps the LAST duplicate, which lets `decision=deny&decision=approve` or a repeated `user_code` pick a value
 * the user never saw. Approval handlers use this parser instead and fail closed.
 */
const MAX_FIELDS = 32;
const MAX_KEY = 64;
const MAX_VALUE = 4096;

export function parseFormStrict(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  const params = Object.create(null);
  let count = 0;
  for (const [key, value] of new URLSearchParams(text)) {
    count += 1;
    if (count > MAX_FIELDS || key.length > MAX_KEY || value.length > MAX_VALUE) {
      return { ok: false, reason: 'invalid_form' };
    }
    if (key in params) return { ok: false, reason: 'duplicate_field', field: key.slice(0, 32) };
    params[key] = value;
  }
  return { ok: true, params };
}
