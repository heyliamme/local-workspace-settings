// JSON values and comparisons.
export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [k: string]: Json;
}

export const isObj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** A canonical string: equal values (whatever their key order) give equal strings. */
export function canon(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v))
    return Object.keys(v)
      .sort()
      .reduce<Record<string, unknown>>((o, k) => ((o[k] = sortKeys(v[k])), o), {});
  return v;
}

export const same = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : canon(a) === canon(b));

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * `*` matches any run of characters; everything else is literal. Linear time: the patterns
 * can come from a committed file, so no regular expression that could backtrack.
 */
export function globMatch(pattern: string, key: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === key;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (key.length < first.length + last.length || !key.startsWith(first) || !key.endsWith(last)) return false;
  let at = first.length;
  const end = key.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    if (!mid) continue;
    const i = key.indexOf(mid, at);
    if (i < 0 || i + mid.length > end) return false;
    at = i + mid.length;
  }
  return true;
}

/** The value of the most specific pattern (fewest wildcards, then longest) that matches. */
export function lookup<T>(rules: Record<string, T> | undefined, key: string): { pattern: string; value: T } | undefined {
  if (!rules) return undefined;
  let best: { pattern: string; value: T; score: number } | undefined;
  for (const [pattern, value] of Object.entries(rules)) {
    if (!globMatch(pattern, key)) continue;
    const wild = pattern.split('*').length - 1;
    const score = (wild === 0 ? 1e6 : 0) + pattern.length * 10 - wild;
    if (!best || score > best.score) best = { pattern, value, score };
  }
  return best && { pattern: best.pattern, value: best.value };
}
