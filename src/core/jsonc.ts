// Reading and editing JSON with comments the way VS Code does, keeping everything that
// isn't changed: comments, key order, indentation and line endings. A file with a syntax
// error is refused, never replaced.
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { canon, isObj, type Json, type JsonObject } from './value';

export class SyntaxProblem extends Error {
  constructor(
    readonly file: string,
    readonly detail: string,
    readonly line?: number,
  ) {
    super(`${file} can't be read: ${detail}${line ? ` on line ${line}` : ''}. Fix it and save; nothing is written until it parses.`);
  }
}

/** Parses a settings document. Empty text (or only comments) is an empty object. */
export function parseObject(text: string, file = 'The file'): JsonObject {
  const body = stripBom(text);
  if (!body.trim()) return {};
  const errors: ParseError[] = [];
  const v = parse(body, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
  if (errors.length) {
    const e = errors[0];
    throw new SyntaxProblem(file, printParseErrorCode(e.error), body.slice(0, e.offset).split('\n').length);
  }
  if (v === undefined) return {};
  if (!isObj(v)) throw new SyntaxProblem(file, 'it is not a JSON object');
  // VS Code takes the last of two equal keys, but an edit would change the first one.
  const dup = duplicateKey(parseTree(body, [], { allowTrailingComma: true }));
  if (dup) throw new SyntaxProblem(file, `"${dup.key}" appears twice in the same object (VS Code uses the last one); remove one of them`, body.slice(0, dup.offset).split('\n').length);
  return v;
}

function duplicateKey(node: Node | undefined): { key: string; offset: number } | undefined {
  if (!node) return undefined;
  if (node.type === 'object') {
    const seen = new Set<string>();
    for (const p of node.children ?? []) {
      const k = p.children?.[0];
      if (!k || typeof k.value !== 'string') continue;
      if (seen.has(k.value)) return { key: k.value, offset: k.offset };
      seen.add(k.value);
    }
  }
  for (const c of node.children ?? []) {
    const d = duplicateKey(c);
    if (d) return d;
  }
  return undefined;
}

/** The object at `path` inside a document (a workspace file's "settings"), {} when absent. */
export function parseBlock(text: string, path: string[], file?: string): JsonObject {
  const root = parseObject(text, file);
  let cur: Json | undefined = root;
  for (const s of path) cur = isObj(cur) ? cur[s] : undefined;
  if (cur === undefined) return {};
  if (!isObj(cur)) throw new SyntaxProblem(file ?? 'The file', `"${path.join('.')}" is not an object`);
  return cur;
}

export const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

export interface Format {
  eol: '\n' | '\r\n';
  insertSpaces: boolean;
  tabSize: number;
}

export function detectFormat(text: string): Format {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return { eol, insertSpaces: true, tabSize: 4 };
  if (m[1].startsWith('\t')) return { eol, insertSpaces: false, tabSize: 1 };
  return { eol, insertSpaces: true, tabSize: m[1].length };
}

/**
 * Makes the object at `block` hold exactly `target`, changing only the top-level keys
 * (of the block) that differ. Untouched keys keep their text and comments; a changed
 * object value keeps the comments of its own unchanged keys too. The result is checked
 * by parsing it again.
 */
export function setBlock(text: string, block: string[], target: JsonObject, fmt?: Partial<Format>): string {
  const format = { ...detectFormat(text), ...fmt };
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  let out = stripBom(text);
  if (!out.trim()) out = '{}';
  else if (!hasRootObject(out)) out = out.trimEnd() + format.eol + '{}';
  const current = parseBlock(out, block);
  if (block.length && findNodeAtLocation(parseTree(out)!, block) === undefined) {
    out = applyEdits(out, modify(out, block, {}, { formattingOptions: format }));
  }
  out = editObject(out, block, current, target, format);
  if (!out.endsWith('\n')) out += format.eol;
  const check = parseBlock(out, block);
  if (canon(check) !== canon(target)) throw new Error('The edited file would not hold the expected settings; nothing was written.');
  return bom + out;
}

function hasRootObject(text: string): boolean {
  try {
    return parseTree(text)?.type === 'object';
  } catch {
    return false;
  }
}

/** Edits one object level: removes, adds and replaces keys; recurses into objects on both sides. */
function editObject(text: string, at: string[], current: JsonObject, target: JsonObject, format: Format): string {
  let out = text;
  for (const k of Object.keys(current)) {
    if (!(k in target)) out = applyEdits(out, modify(out, [...at, k], undefined, { formattingOptions: format }));
  }
  for (const [k, v] of Object.entries(target)) {
    const cur = current[k];
    if (cur !== undefined && canon(cur) === canon(v)) continue;
    if (isObj(cur) && isObj(v) && at.length < 8) out = editObject(out, [...at, k], cur, v, format);
    else out = applyEdits(out, modify(out, [...at, k], v, { formattingOptions: format }));
  }
  return out;
}

/** A fresh document holding `obj`, with leading comment lines. */
export function newDocument(obj: JsonObject, comments: string[], format: Partial<Format> = {}): string {
  const f = { eol: '\n' as const, insertSpaces: true, tabSize: 4, ...format };
  const head = comments.map((c) => `// ${c}`.trimEnd()).join(f.eol);
  const body = setBlock('{}', [], obj, f);
  return (head ? head + f.eol : '') + body;
}

/** Removes the given comment lines from the top of a document (an earlier header). */
export function dropHeader(text: string, header: string[]): string {
  const known = new Set(header.map((h) => `// ${h}`.trimEnd()));
  const body = stripBom(text);
  const lines = body.split(/(?<=\n)/);
  let i = 0;
  while (i < lines.length && known.has(lines[i].replace(/\r?\n$/, '').trimEnd())) i++;
  return lines.slice(i).join('');
}

/** Puts the header comment at the top of a document, replacing an earlier copy of it. */
export function withHeader(text: string, header: string[], eol: string): string {
  const body = dropHeader(text, header);
  return header.length ? header.map((h) => `// ${h}`.trimEnd()).join(eol) + eol + body : body;
}
