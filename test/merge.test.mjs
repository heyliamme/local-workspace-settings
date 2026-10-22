// Merge semantics: what shared + local turn into, and the reverse (the local override a
// result needs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from './helpers.mjs';

const { merge, overrideFor, routeToLocal, describe, changedKeys, strategyFor } = core;

test('local wins, and settings only in one layer are kept', () => {
  assert.deepEqual(merge({ a: 1, b: 2 }, { b: 3, c: 4 }), { a: 1, b: 3, c: 4 });
});

test('objects merge key by key, at any depth', () => {
  const shared = { 'files.exclude': { '**/.git': true, '**/node_modules': true }, '[python]': { 'editor.tabSize': 4, 'editor.rulers': [88] } };
  const local = { 'files.exclude': { '**/dist': true }, '[python]': { 'editor.tabSize': 2 } };
  assert.deepEqual(merge(shared, local), {
    'files.exclude': { '**/.git': true, '**/node_modules': true, '**/dist': true },
    '[python]': { 'editor.tabSize': 2, 'editor.rulers': [88] },
  });
});

test('lists replace by default', () => {
  assert.deepEqual(merge({ 'cSpell.words': ['a', 'b'] }, { 'cSpell.words': ['c'] }), { 'cSpell.words': ['c'] });
});

test('lists append, prepend or union when a rule says so, also inside a language block', () => {
  const s = { 'cSpell.words': ['a', 'b'], 'editor.rulers': [80], '[go]': { 'editor.rulers': [100] } };
  const l = { 'cSpell.words': ['b', 'c'], 'editor.rulers': [120], '[go]': { 'editor.rulers': [120] } };
  assert.deepEqual(merge(s, l, { 'cSpell.*': 'union', 'editor.rulers': 'append' }), { 'cSpell.words': ['a', 'b', 'c'], 'editor.rulers': [80, 120], '[go]': { 'editor.rulers': [100, 120] } });
  assert.deepEqual(merge(s, l, { 'cSpell.words': 'prepend' })['cSpell.words'], ['b', 'c', 'a', 'b']);
});

test('the most specific array rule wins', () => {
  assert.equal(core.strategyFor({ '*': 'append', 'cSpell.*': 'union', 'cSpell.words': 'replace' }, 'cSpell.words'), 'replace');
  assert.equal(core.strategyFor({ '*': 'append', 'cSpell.*': 'union' }, 'cSpell.userWords'), 'union');
  assert.equal(core.strategyFor({ '*': 'append' }, 'x'), 'append');
  assert.equal(core.strategyFor({ x: 'nonsense' }, 'x'), 'replace');
});

test('null removes a shared setting, or one key of a shared object', () => {
  assert.deepEqual(merge({ a: 1, b: 2 }, { a: null }), { b: 2 });
  assert.deepEqual(merge({ 'files.exclude': { x: true, y: true } }, { 'files.exclude': { x: null } }), { 'files.exclude': { y: true } });
  // Nothing to remove: no key appears.
  assert.deepEqual(merge({}, { a: null, o: { k: null, j: 1 } }), { o: { j: 1 } });
});

test('$replace replaces an object or a list instead of merging', () => {
  assert.deepEqual(merge({ o: { a: 1, b: 2 } }, { o: { $replace: { c: 3 } } }), { o: { c: 3 } });
  assert.deepEqual(merge({ l: [1] }, { l: { $replace: [2] } }, { l: 'append' }), { l: [2] });
  assert.deepEqual(merge({ a: 1 }, { a: { $replace: null } }), { a: null });
});

test('merging does not change its inputs', () => {
  const s = { o: { a: [1] } };
  const l = { o: { b: 2 } };
  const r = merge(s, l);
  r.o.a.push(9);
  assert.deepEqual(s, { o: { a: [1] } });
  assert.deepEqual(l, { o: { b: 2 } });
});

test('overrideFor gives the smallest override, and merging it back gives the target', () => {
  const cases = [
    [1, 2, 'k', undefined, 2],
    [1, 1, 'k', undefined, undefined],
    [1, undefined, 'k', undefined, null],
    [undefined, undefined, 'k', undefined, undefined],
    [undefined, 5, 'k', undefined, 5],
    [{ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }, 'o', undefined, { b: 3, c: 4 }],
    [{ a: 1, b: 2 }, { a: 1 }, 'o', undefined, { b: null }],
    [{ a: { x: 1, y: 2 } }, { a: { x: 1, y: 3 } }, 'o', undefined, { a: { y: 3 } }],
    [[1, 2], [1, 2, 3], 'l', { l: 'append' }, [3]],
    [[1, 2], [0, 1, 2], 'l', { l: 'prepend' }, [0]],
    [[1, 2], [1, 2, 3], 'l', { l: 'union' }, [3]],
    [[1, 2], [3], 'l', undefined, [3]],
    // Not reachable by appending: replaced explicitly.
    [[1, 2], [2], 'l', { l: 'append' }, { $replace: [2] }],
    // A null value can't be expressed as null (that means "remove").
    [1, null, 'k', undefined, { $replace: null }],
    [{ a: 1 }, 'str', 'k', undefined, 'str'],
  ];
  for (const [b, t, name, rules, want] of cases) {
    const o = overrideFor(b, t, name, rules);
    assert.deepEqual(o, want, JSON.stringify({ b, t }));
    const shared = b === undefined ? {} : { [name]: b };
    const local = o === undefined ? {} : { [name]: o };
    assert.deepEqual(merge(shared, local, rules)[name], t, `round trip ${JSON.stringify({ b, t })}`);
  }
});

test('routeToLocal adds, changes and drops overrides', () => {
  assert.deepEqual(routeToLocal({ a: 1 }, {}, 'a', 2), { a: 2 });
  assert.deepEqual(routeToLocal({ a: 1 }, { a: 2 }, 'a', 1), {});
  assert.deepEqual(routeToLocal({ a: 1 }, {}, 'a', undefined), { a: null });
  assert.deepEqual(routeToLocal({}, { a: 2 }, 'a', undefined), {});
});

test('describe says where each setting comes from', () => {
  const d = describe({ a: 1, b: 2, c: 3 }, { b: 5, c: null, d: 4, e: null });
  assert.deepEqual(
    d.map((k) => [k.key, k.origin, k.effective]),
    [
      ['a', 'shared', 1],
      ['b', 'overridden', 5],
      ['c', 'removed', undefined],
      ['d', 'local', 4],
    ],
  );
});

test('changedKeys compares values, not key order', () => {
  assert.deepEqual(changedKeys({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 2, x: 1 }, c: 1 }), ['b', 'c']);
});

test('array rule patterns match in linear time, even with many stars', () => {
  const { globMatch, lookup } = core;
  assert.equal(globMatch('peacock.*', 'peacock.color'), true);
  assert.equal(globMatch('*.words', 'cSpell.words'), true);
  assert.equal(globMatch('a*b*c', 'axxbyyc'), true);
  assert.equal(globMatch('a*b*c', 'axxcyyb'), false);
  assert.equal(globMatch('ab*ba', 'aba'), false, 'prefix and suffix may not overlap');
  assert.equal(globMatch('x', 'x'), true);
  assert.equal(globMatch('x.y', 'xzy'), false, 'dots are literal');
  const t0 = Date.now();
  assert.equal(globMatch('*'.repeat(40) + 'X', 'editor.rulers'), false);
  assert.equal(strategyFor({ ['*'.repeat(200) + 'X']: 'append' }, 'editor.rulers'), 'replace');
  assert.ok(Date.now() - t0 < 100, 'no backtracking');
  assert.equal(lookup({ '*': 1, 'cSpell.*': 2 }, 'cSpell.words').value, 2);
});

test('sharing a change publishes only the change: personal keys of an object stay local', () => {
  const { shareChange } = core;
  const base = { 'files.exclude': { node_modules: true }, '[python]': { 'editor.tabSize': 4 } };
  const local = { 'files.exclude': { 'my-scratch': true }, '[python]': { 'python.defaultInterpreterPath': '/home/sam/venv/bin/python' } };
  const before = merge(base, local);
  const after = { 'files.exclude': { ...before['files.exclude'], dist: true }, '[python]': { ...before['[python]'], 'editor.tabSize': 2 } };
  for (const k of Object.keys(after)) {
    const shared = shareChange(base[k], before[k], after[k]);
    assert.ok(!JSON.stringify(shared).includes('my-scratch') && !JSON.stringify(shared).includes('/home/sam'), `${k} leaks nothing`);
    const nextLocal = routeToLocal({ ...base, [k]: shared }, local, k, after[k]);
    assert.deepEqual(merge({ ...base, [k]: shared }, nextLocal)[k], after[k], `${k} round trip`);
    assert.deepEqual(nextLocal[k], local[k], `${k} personal part unchanged`);
  }
  assert.equal(shareChange(1, 2, undefined), undefined);
  assert.deepEqual(shareChange([1], [1, 2], [1, 2, 3]), [1, 2, 3], 'a list is shared as shown');
});

test('a { "$replace": … } override keeps saying replace when the value is changed again', () => {
  const base = { 'files.exclude': { node_modules: true } };
  const local = routeToLocal(base, { 'files.exclude': { $replace: { a: true } } }, 'files.exclude', { a: true, b: true });
  assert.deepEqual(local, { 'files.exclude': { $replace: { a: true, b: true } } });
  // A later team addition stays out.
  assert.deepEqual(merge({ 'files.exclude': { node_modules: true, 'secret-build': true } }, local)['files.exclude'], { a: true, b: true });
  // Also one level down.
  const nested = routeToLocal({ '[python]': { 'editor.rulers': [80] } }, { '[python]': { 'editor.rulers': { $replace: [100] } } }, '[python]', { 'editor.rulers': [100, 120] });
  assert.deepEqual(nested, { '[python]': { 'editor.rulers': { $replace: [100, 120] } } });
});

test('sharing a list change under an append, prepend or union rule shares only the entries that changed', () => {
  const { shareChange } = core;
  const rules = { w: 'union', a: 'append', p: 'prepend' };
  // Effective lists are the team's joined with personal entries ("me").
  assert.deepEqual(shareChange(['t'], ['t', 'me'], ['t', 'me', 'new'], 'w', rules), ['t', 'new']);
  assert.deepEqual(shareChange(['t', 'x'], ['t', 'x', 'me'], ['t', 'me'], 'w', rules), ['t'], 'a removed team entry');
  assert.deepEqual(shareChange(['t'], ['t', 'me'], ['t', 'me', 'new'], 'a', rules), ['t', 'new']);
  assert.deepEqual(shareChange(['t'], ['me', 't'], ['new', 'me', 't'], 'p', rules), ['new', 't']);
  assert.deepEqual(shareChange(['t'], ['t', 'me'], ['t', 'me', 'new'], 'other', rules), ['t', 'me', 'new'], 'replace shares the list as shown');
  assert.deepEqual(shareChange({ '[md]': { w: ['t'] } }, { '[md]': { w: ['t', 'me'] } }, { '[md]': { w: ['t', 'me', 'n'] } }, '[md]', rules), { '[md]': { w: ['t', 'n'] } });
});
