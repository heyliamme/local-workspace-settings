// How shared and local settings combine, and the reverse: what local override turns the
// shared settings into a given result.
//
// - Local wins.
// - Objects (files.exclude, "[python]" blocks, ...) merge key by key, at any depth.
// - Lists replace the shared list, unless a rule in arrayMerge says append, prepend or union.
// - null in the local file removes the setting (or the object key) from the result.
// - { "$replace": value } in the local file replaces whatever is shared, without merging.
import { canon, clone, isObj, lookup, same, type Json, type JsonObject } from './value';

export type ArrayStrategy = 'replace' | 'append' | 'prepend' | 'union';
export type ArrayRules = Record<string, ArrayStrategy>;

export const REPLACE = '$replace';
const isReplace = (v: Json | undefined): v is { $replace: Json } => isObj(v) && Object.keys(v).length === 1 && REPLACE in v;

/** The setting name a nested key belongs to: keys of a "[lang]" block are setting names themselves. */
const nameOf = (parent: string | undefined, key: string) => (parent === undefined || /^\[.*\]$/.test(parent) ? key : parent);

export function strategyFor(rules: ArrayRules | undefined, name: string): ArrayStrategy {
  const v = lookup(rules, name)?.value;
  return v === 'append' || v === 'prepend' || v === 'union' ? v : 'replace';
}

export function merge(base: JsonObject, local: JsonObject, rules?: ArrayRules): JsonObject {
  return mergeObject(base, local, undefined, rules);
}

function mergeObject(base: JsonObject, local: JsonObject, parent: string | undefined, rules?: ArrayRules): JsonObject {
  const out = clone(base);
  for (const [k, lv] of Object.entries(local)) {
    if (lv === null) delete out[k];
    else {
      const v = mergeValue(base[k], lv, nameOf(parent, k), rules);
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
  }
  return out;
}

function mergeValue(b: Json | undefined, l: Json, name: string, rules?: ArrayRules): Json | undefined {
  if (isReplace(l)) return clone(l.$replace);
  if (isObj(l) && isObj(b)) return mergeObject(b, l, name, rules);
  if (isObj(l)) return stripMarkers(l);
  if (Array.isArray(l) && Array.isArray(b)) {
    const s = strategyFor(rules, name);
    if (s === 'append') return [...clone(b), ...clone(l)];
    if (s === 'prepend') return [...clone(l), ...clone(b)];
    if (s === 'union') {
      const seen = new Set(b.map(canon));
      const extra: Json[] = [];
      for (const x of l) if (!seen.has(canon(x))) (seen.add(canon(x)), extra.push(clone(x)));
      return [...clone(b), ...extra];
    }
  }
  return clone(l);
}

/** A local object with nothing under it in the shared settings: nulls and markers resolve against nothing. */
function stripMarkers(o: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null) continue;
    if (isReplace(v)) out[k] = clone(v.$replace);
    else out[k] = isObj(v) ? stripMarkers(v) : clone(v);
  }
  return out;
}

/**
 * The smallest local value for one setting such that merging it over `b` gives `t`;
 * undefined when no override is needed. `t` undefined means "the setting is gone".
 * `prev` is the local value this replaces: where it said { "$replace": ... }, the new
 * value says so too, so later team additions stay out.
 */
export function overrideFor(b: Json | undefined, t: Json | undefined, name: string, rules?: ArrayRules, prev?: Json): Json | undefined {
  if (t !== undefined && isReplace(prev)) return { [REPLACE]: clone(t) };
  const o = rawOverride(b, t, name, rules, prev);
  if (o === undefined) return undefined;
  if (t === undefined) return o;
  // Some results can't be reached by merging (a null value over nothing, a list an
  // append rule would duplicate): say "replace" explicitly.
  // null in a layer means "remove", so a null value is always written as a replacement.
  const got = o === null ? undefined : mergeValue(b, o, name, rules);
  return got !== undefined && same(got, t) ? o : { [REPLACE]: clone(t) };
}

function rawOverride(b: Json | undefined, t: Json | undefined, name: string, rules?: ArrayRules, prev?: Json): Json | undefined {
  if (t === undefined) return b === undefined ? undefined : null;
  if (b !== undefined && same(b, t)) return undefined;
  if (isObj(b) && isObj(t)) {
    const o: JsonObject = {};
    for (const [k, tv] of Object.entries(t)) {
      const sub = overrideFor(b[k], tv, nameOf(name, k), rules, isObj(prev) ? prev[k] : undefined);
      if (sub !== undefined) o[k] = sub;
    }
    for (const k of Object.keys(b)) if (!(k in t)) o[k] = null;
    return o;
  }
  if (Array.isArray(b) && Array.isArray(t)) {
    const s = strategyFor(rules, name);
    const head = (n: number) => canon(t.slice(0, n)) === canon(b);
    if (s === 'append' && t.length >= b.length && head(b.length)) return t.slice(b.length);
    if (s === 'prepend' && t.length >= b.length && canon(t.slice(t.length - b.length)) === canon(b)) return t.slice(0, t.length - b.length);
    if (s === 'union' && head(b.length)) return t.slice(b.length);
  }
  return clone(t);
}

/** The local settings after making the effective value of `key` be `value` (undefined: unset). */
export function routeToLocal(base: JsonObject, local: JsonObject, key: string, value: Json | undefined, rules?: ArrayRules): JsonObject {
  const out = clone(local);
  const o = overrideFor(base[key], value, key, rules, local[key]);
  if (o === undefined) delete out[key];
  else out[key] = o;
  return out;
}

/**
 * The team's value after the effective value went from `before` to `after` and that change
 * is shared: only what changed reaches the team's value `b`, key by key inside objects and
 * entry by entry in a list that an append, prepend or union rule merges, so the rest of a
 * personal override (an entry of files.exclude, a key of a "[python]" block, a word of a
 * personal word list) stays personal. undefined: the setting is gone. `name` is the setting
 * the value belongs to, for its list rule.
 */
export function shareChange(b: Json | undefined, before: Json | undefined, after: Json | undefined, name = '', rules?: ArrayRules): Json | undefined {
  if (after === undefined) return undefined;
  if (isObj(before) && isObj(after) && (b === undefined || isObj(b))) {
    const out: JsonObject = clone(b ?? {});
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (same(before[k], after[k])) continue;
      const v = shareChange(out[k], before[k], after[k], nameOf(name, k), rules);
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  }
  const s = strategyFor(rules, name);
  if (s !== 'replace' && Array.isArray(before) && Array.isArray(after) && (b === undefined || Array.isArray(b))) {
    // The list is the team's list joined with personal entries: share the entries that
    // were added or removed, never the personal ones that were already there.
    const count = (xs: Json[]) => xs.reduce((m, x) => m.set(canon(x), (m.get(canon(x)) ?? 0) + 1), new Map<string, number>());
    const was = count(before);
    const now = count(after);
    const added: Json[] = [];
    for (const x of after) {
      const k = canon(x);
      if ((was.get(k) ?? 0) > 0) was.set(k, was.get(k)! - 1);
      else added.push(clone(x));
    }
    const gone = new Map<string, number>();
    for (const x of before) {
      const k = canon(x);
      if ((now.get(k) ?? 0) > 0) now.set(k, now.get(k)! - 1);
      else gone.set(k, (gone.get(k) ?? 0) + 1);
    }
    const kept: Json[] = [];
    for (const x of b ?? []) {
      const k = canon(x);
      if ((gone.get(k) ?? 0) > 0) gone.set(k, gone.get(k)! - 1);
      else kept.push(clone(x));
    }
    const have = new Set(kept.map(canon));
    const extra = s === 'union' ? added.filter((x) => !have.has(canon(x)) && (have.add(canon(x)), true)) : added;
    return s === 'prepend' ? [...extra, ...kept] : [...kept, ...extra];
  }
  return clone(after);
}

/**
 * The value to keep for this user after a change to `key` was shared: `want`, or, for a
 * list that a rule merges, the same entries in the order the merge gives them, so the
 * local file keeps a plain list of personal entries instead of a { "$replace": … }.
 */
export function afterSharing(team: JsonObject, local: JsonObject, key: string, want: Json | undefined, rules?: ArrayRules): Json | undefined {
  const got = merge(team, local, rules)[key];
  if (!Array.isArray(got) || !Array.isArray(want) || strategyFor(rules, key) === 'replace' || got.length !== want.length) return want;
  return canon([...got].map(canon).sort()) === canon([...want].map(canon).sort()) ? got : want;
}

export type Origin = 'shared' | 'local' | 'overridden' | 'removed';

export interface KeyInfo {
  key: string;
  origin: Origin;
  shared?: Json;
  local?: Json;
  effective?: Json;
}

/** Every setting in either layer, with where its effective value comes from. */
export function describe(base: JsonObject, local: JsonObject, rules?: ArrayRules): KeyInfo[] {
  const eff = merge(base, local, rules);
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local)])].sort((a, b) => a.localeCompare(b));
  const out: KeyInfo[] = [];
  for (const key of keys) {
    const inBase = key in base;
    const inLocal = key in local;
    if (inLocal && local[key] === null && !inBase) continue;
    const origin: Origin = !inLocal ? 'shared' : !inBase ? 'local' : local[key] === null ? 'removed' : 'overridden';
    out.push({ key, origin, shared: base[key], local: local[key], effective: eff[key] });
  }
  return out;
}

/** Top-level keys whose value differs between two versions of the effective settings. */
export function changedKeys(before: JsonObject, after: JsonObject): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => !same(before[k], after[k])).sort();
}
