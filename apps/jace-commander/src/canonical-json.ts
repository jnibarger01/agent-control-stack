/**
 * Strict canonical JSON v1 (acs.jc.v1 signing/verification canonicalization).
 *
 * JC-owned copy of the ACS contract function. It MUST stay byte-identical with
 * the ACS issuer: test/acs-interop.test.mjs verifies a signed ACS vector and
 * test/canonical-json.test.mjs pins the rules.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sortedOwnKeys(value: Record<string, unknown>): string[] {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('strict canonical JSON rejects symbol keys');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) throw new TypeError('strict canonical JSON rejects non-enumerable properties');
    if ('get' in descriptor || 'set' in descriptor) throw new TypeError('strict canonical JSON rejects accessors');
  }
  return (ownKeys as string[]).sort();
}

export function strictCanonicalJsonV1(value: unknown): string {
  const active = new Set<object>();

  const serialize = (entry: unknown): string => {
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') {
      return JSON.stringify(entry);
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new TypeError('strict canonical JSON requires finite numbers');
      return JSON.stringify(entry);
    }
    if (entry === undefined) throw new TypeError('strict canonical JSON rejects undefined');
    if (typeof entry === 'bigint' || typeof entry === 'symbol' || typeof entry === 'function') {
      throw new TypeError(`strict canonical JSON rejects ${typeof entry}`);
    }
    if (active.has(entry)) throw new TypeError('strict canonical JSON rejects cycles');
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (Object.getPrototypeOf(entry) !== Array.prototype) {
          throw new TypeError('strict canonical JSON requires a plain array');
        }
        const ownKeys = Reflect.ownKeys(entry);
        const allowedKeys = new Set(['length', ...Array.from({ length: entry.length }, (_, index) => String(index))]);
        if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
          throw new TypeError('strict canonical JSON rejects extra array properties');
        }
        const serialized: string[] = [];
        for (let index = 0; index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (descriptor === undefined) {
            throw new TypeError('strict canonical JSON rejects sparse arrays');
          }
          if (!descriptor.enumerable) {
            throw new TypeError('strict canonical JSON rejects non-enumerable array entries');
          }
          if (!('value' in descriptor)) {
            throw new TypeError('strict canonical JSON rejects array accessors');
          }
          serialized.push(serialize(descriptor.value));
        }
        return `[${serialized.join(',')}]`;
      }
      if (!isPlainObject(entry)) throw new TypeError('strict canonical JSON requires plain objects');
      const keys = sortedOwnKeys(entry);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(entry[key])}`).join(',')}}`;
    } finally {
      active.delete(entry);
    }
  };

  return serialize(value);
}
