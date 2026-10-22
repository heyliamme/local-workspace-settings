// Editing JSON with comments: only what changes is touched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from './helpers.mjs';

const { setBlock, parseObject, parseBlock, newDocument, withHeader, dropHeader } = core;

test('a malformed document is refused with the line', () => {
  assert.throws(() => parseObject('{\n  "a": 1,\n  "b" 2\n}', 'settings.json'), (e) => e instanceof core.SyntaxProblem && e.line === 3 && /settings\.json can't be read/.test(e.message));
  assert.throws(() => parseObject('[1]'), /not a JSON object/);
  assert.deepEqual(parseObject(''), {});
  assert.deepEqual(parseObject('// only a comment\n'), {});
  assert.deepEqual(parseObject('﻿{"a": 1,}'), { a: 1 });
});

test('setBlock keeps comments, order and indentation of untouched keys', () => {
  const text = '{\n    // Team font\n    "editor.fontSize": 14, // trailing\n    /* block */\n    "files.exclude": {\n        // build output\n        "dist": true\n    },\n    "z": 1\n}\n';
  const out = setBlock(text, [], { 'editor.fontSize': 14, 'files.exclude': { dist: true, out: true }, z: 2, added: 'x' });
  assert.match(out, /\/\/ Team font\n {4}"editor\.fontSize": 14, \/\/ trailing/);
  assert.match(out, /\/\* block \*\//);
  assert.match(out, /\/\/ build output\n {8}"dist": true,\n {8}"out": true/);
  assert.match(out, /"z": 2/);
  assert.deepEqual(parseObject(out), { 'editor.fontSize': 14, 'files.exclude': { dist: true, out: true }, z: 2, added: 'x' });
});

test('setBlock removes keys, keeps CRLF and a BOM', () => {
  const text = '﻿{\r\n\t"a": 1,\r\n\t"b": 2\r\n}\r\n';
  const out = setBlock(text, [], { b: 3 });
  assert.equal(out, '﻿{\r\n\t"b": 3\r\n}\r\n');
});

test('setBlock edits a workspace file\'s settings block and nothing else', () => {
  const text = '{\n  // folders\n  "folders": [{ "path": "." }],\n  "settings": {\n    "a": 1\n  }\n}\n';
  const out = setBlock(text, ['settings'], { a: 1, b: true });
  assert.match(out, /\/\/ folders\n {2}"folders": \[\{ "path": "\." \}\]/);
  assert.deepEqual(parseBlock(out, ['settings']), { a: 1, b: true });
  const noBlock = setBlock('{ "folders": [] }', ['settings'], { c: 1 });
  assert.deepEqual(parseObject(noBlock), { folders: [], settings: { c: 1 } });
});

test('setBlock on an empty or comment-only file', () => {
  assert.deepEqual(parseObject(setBlock('', [], { a: 1 })), { a: 1 });
  const c = setBlock('// hello\n', [], { a: 1 });
  assert.match(c, /^\/\/ hello\n\{/);
  assert.deepEqual(parseObject(c), { a: 1 });
});

test('large documents edit quickly', () => {
  const big = {};
  for (let i = 0; i < 3000; i++) big[`ext${i}.setting`] = { nested: i, list: [i, i + 1] };
  const text = JSON.stringify(big, null, 4);
  const t0 = Date.now();
  const out = setBlock(text, [], { ...big, 'ext5.setting': 1, extra: true });
  assert.equal(parseObject(out)['ext5.setting'], 1);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test('headers are added once and replaced, not stacked', () => {
  const h = ['Generated', 'twice?'];
  const once = withHeader('{}\n', h, '\n');
  assert.equal(withHeader(once, h, '\n'), once);
  assert.equal(dropHeader(once, h), '{}\n');
  assert.equal(dropHeader('// mine\n{}', h), '// mine\n{}');
  assert.match(newDocument({ a: 1 }, ['x']), /^\/\/ x\n\{\n {4}"a": 1\n\}\n$/);
});

test('a duplicate key is refused by name and line, not left to fail an edit later', () => {
  assert.throws(() => core.parseObject('{\n  "a": 1,\n  "b": 0,\n  "a": 2\n}', 'settings.local.json'), (e) => e instanceof core.SyntaxProblem && /"a" appears twice/.test(e.message) && e.line === 4 && e.file === 'settings.local.json');
  assert.throws(() => core.parseObject('{ "x": { "k": 1, "k": 2 } }'), /"k" appears twice/);
  assert.deepEqual(core.parseObject('{ "a": { "k": 1 }, "b": { "k": 2 } }'), { a: { k: 1 }, b: { k: 2 } }, 'the same key in two objects is fine');
});
