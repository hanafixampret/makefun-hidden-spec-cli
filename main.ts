// main.ts is mend, the CLI SPEC.md specifies: it applies an AI-written edit in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a tree of text files,
// finding the lines an edit names at the first of three matching tiers, and writes every change
// or none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and
// write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own break, and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** Matching tiers (section 5): 0 exact, 1 trailing spaces/tabs off, 2 both sides off. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchAt(lines: string[], i: number, o: string[], tier: number): boolean {
  for (let j = 0; j < o.length; j += 1) {
    if (norm(lines[i + j]!, tier) !== norm(o[j]!, tier)) return false;
  }
  return true;
}

function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (matchAt(lines, i, o, tier)) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, or null (section 5). */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrences(lines, o, t, from).length > 0) return t;
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** One line of N: a context line (the file's own matched line) or a new line. */
type NEnt = { ctx: true; o: number } | { ctx: false; text: string };

/** Build the lines N writes: context lines as the file's own, other lines re-indented at tier 2. */
function buildNew(n: NEnt[], o: string[], fileLines: string[], pos: number, tier: number | null): string[] {
  if (tier !== 2 || o.length === 0) {
    return n.map((e) => (e.ctx ? fileLines[pos + e.o]! : e.text));
  }
  const p = leadingWs(o[0]!);
  const f = leadingWs(fileLines[pos]!);
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + e.o]!;
    const t = e.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  private moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
  movePairs(): Array<[string, string]> {
    return this.moves;
  }
  snapshotMoves(): number {
    return this.moves.length;
  }
  truncateMoves(n: number): void {
    this.moves.length = n;
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Unified diffs (section 6). */

interface Hunk {
  a: number;
  O: string[];
  N: NEnt[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEolAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoEol: boolean;
  hasPlus: boolean;
}

function parseHunkHead(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? Number(m[1]) : null;
}

function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const raw: string[] = [];
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    const isBody = l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
    if (!isBody) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    raw.push(l);
    j += 1;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const O: string[] = [];
  const N: NEnt[] = [];
  const kinds: string[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      kinds.push('\\');
      continue;
    }
    if (l === '' || l.startsWith(' ')) {
      kinds.push(' ');
      const text = l === '' ? '' : l.slice(1);
      O.push(text);
      N.push({ ctx: true, o: O.length - 1 });
    } else if (l.startsWith('-')) {
      kinds.push('-');
      O.push(l.slice(1));
    } else {
      kinds.push('+');
      N.push({ ctx: false, text: l.slice(1) });
    }
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  let hasPlus = false;
  for (let k = 0; k < kinds.length; k += 1) {
    if (kinds[k] === ' ' || kinds[k] === '+') lastCtxPlus = k;
    if (kinds[k] === '+') {
      lastPlus = k;
      hasPlus = true;
    }
  }
  return {
    hunk: {
      a: 0,
      O,
      N,
      noEolAfterLast: lastCtxPlus >= 0 && kinds[lastCtxPlus + 1] === '\\',
      lastPlusNoEol: lastPlus >= 0 && kinds[lastPlus + 1] === '\\',
      hasPlus,
    },
    next: j,
  };
}

interface UniSection {
  oldP: string | null;
  newP: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const cut = tab >= 0 ? rest.slice(0, tab) : rest;
  return stripPrefix(cut.trim());
}

function parseDiffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  return m ? [m[1]!, m[2]!] : null;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (s: UniSection): void => {
    sections.push(s);
    cur = s;
    inHeader = true;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ oldP: dg[0], newP: dg[1], hasPair: false, renameFrom: null, renameTo: null, diffOld: dg[0], diffNew: dg[1], isNew: false, isDel: false, hunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      const oldV = oldP === '/dev/null' ? null : oldP;
      const newV = newP === '/dev/null' ? null : newP;
      if (cur !== null && inHeader) {
        cur.oldP = oldV;
        cur.newP = newV;
        cur.hasPair = true;
      } else {
        startSection({ oldP: oldV, newP: newV, hasPair: true, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, isNew: false, isDel: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHead(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i);
      hunk.a = a;
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.hasPair ? s.oldP : (s.renameFrom ?? s.diffOld);
  const newP = s.hasPair ? s.newP : (s.renameTo ?? s.diffNew);
  const oldS = oldP ?? '';
  const newS = newP ?? '';
  if (s.isNew || oldP === null) {
    return (tree) => {
      if (!safe(newS)) throw new Fail('unsafe', newS);
      if (tree.get(newS) !== null) throw new Fail('exists', newS);
      const plus: string[] = [];
      let noEol = false;
      for (const hunk of s.hunks) {
        for (const e of hunk.N) {
          if (!e.ctx) plus.push(e.text);
        }
        if (hunk.hasPlus) noEol = hunk.lastPlusNoEol;
      }
      tree.now.set(newS, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (s.isDel || newP === null) {
    return (tree) => {
      if (!safe(oldS)) throw new Fail('unsafe', oldS);
      if (tree.get(oldS) === null) throw new Fail('missing', oldS);
      tree.now.set(oldS, null);
    };
  }
  if (oldS !== newS) {
    return (tree) => applyUnifiedChange(tree, oldS, newS, s.hunks, strict);
  }
  return (tree) => applyUnifiedChange(tree, oldS, null, s.hunks, strict);
}

function applyUnifiedChange(tree: Tree, oldP: string, newP: string | null, hunks: Hunk[], strict: boolean): void {
  if (!safe(oldP)) throw new Fail('unsafe', oldP);
  if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
  const text = tree.get(oldP);
  if (text === null) throw new Fail('missing', oldP);
  if (newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
  const model = parseFile(text);
  let d = 0;
  for (const hunk of hunks) {
    if (hunk.O.length === 0) {
      const at = Math.min(hunk.a + d, model.lines.length);
      const atEnd = at === model.lines.length;
      const add = buildNew(hunk.N, [], model.lines, 0, null);
      model.lines.splice(at, 0, ...add);
      if (atEnd) model.final = !hunk.noEolAfterLast;
      d += add.length;
    } else {
      const tier = firstTier(model.lines, hunk.O, strict);
      if (tier === null) throw new Fail('no-match', oldP);
      const occs = occurrences(model.lines, hunk.O, tier);
      const target = hunk.a - 1 + d;
      let best = occs[0]!;
      for (const p of occs) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const reachesEnd = best + hunk.O.length === model.lines.length;
      const add = buildNew(hunk.N, hunk.O, model.lines, best, tier);
      model.lines.splice(best, hunk.O.length, ...add);
      if (reachesEnd) model.final = !hunk.noEolAfterLast;
      d += add.length - hunk.O.length;
    }
  }
  const result = joinFile(model);
  if (newP !== null) {
    tree.now.set(oldP, null);
    tree.now.set(newP, result);
    tree.recordMove(oldP, newP);
  } else {
    tree.now.set(oldP, result);
  }
}

/* SEARCH/REPLACE blocks (section 7). */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let j = searchIdx + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    j = eq + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const old = lines.slice(searchIdx + 1, eq);
    const neu = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, old, neu, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, old: string[], neu: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, neu.length === 0 ? '' : neu.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const model = parseFile(text);
    const tier = firstTier(model.lines, old, strict);
    if (tier === null) throw new Fail('no-match', path);
    const occs = occurrences(model.lines, old, tier);
    if (occs.length > 1) throw new Fail('ambiguous', path);
    const pos = occs[0]!;
    const nEnt: NEnt[] = neu.map((t) => ({ ctx: false, text: t }));
    const add = buildNew(nEnt, old, model.lines, pos, tier);
    model.lines.splice(pos, old.length, ...add);
    tree.now.set(path, joinFile(model));
  };
}

/* V4A patches (section 8). */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NEnt[];
}

function v4aSectionEnd(lines: string[], start: number, last: number): number {
  let e = start;
  while (e < last) {
    const l = lines[e]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
    e += 1;
  }
  return e;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDel = line.startsWith('*** Delete File: ');
      const headLen = isAdd ? '*** Add File: '.length : isDel ? '*** Delete File: '.length : '*** Update File: '.length;
      const path = line.slice(headLen).trim();
      const headLine = i;
      let e = v4aSectionEnd(lines, i + 1, last);
      while (e > i + 1 && blank(lines[e - 1]!)) e -= 1;
      if (isAdd) {
        const items: string[] = [];
        for (let k = i + 1; k < e; k += 1) {
          const l = lines[k]!;
          if (l === '') items.push('');
          else if (l.startsWith('+')) items.push(l.slice(1));
          else throw new Exit2(`error: parse ${k + 1}`);
        }
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, items.length === 0 ? '' : items.join('\n') + '\n');
        });
      } else if (isDel) {
        for (let k = i + 1; k < e; k += 1) {
          if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
        }
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
      } else {
        let idx = i + 1;
        let moveTo: string | null = null;
        if (idx < e && lines[idx]!.startsWith('*** Move to: ')) {
          moveTo = lines[idx]!.slice('*** Move to: '.length).trim();
          idx += 1;
        }
        const chunks: Chunk[] = [];
        let current: Chunk | null = null;
        let sawChunk = false;
        const pushCurrent = (): void => {
          if (current !== null) {
            chunks.push(current);
            current = null;
          }
        };
        while (idx < e) {
          const l = lines[idx]!;
          if (l.startsWith('@@')) {
            pushCurrent();
            const anchor = l.slice(2).trim();
            current = { anchor: anchor === '' ? null : anchor, eof: false, O: [], N: [] };
            sawChunk = true;
            idx += 1;
            continue;
          }
          if (l === '*** End of File') {
            if (current === null) throw new Exit2(`error: parse ${idx + 1}`);
            current.eof = true;
            pushCurrent();
            idx += 1;
            continue;
          }
          if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
            if (current === null) {
              if (sawChunk) throw new Exit2(`error: parse ${idx + 1}`);
              current = { anchor: null, eof: false, O: [], N: [] };
              sawChunk = true;
            }
            if (l === '' || l.startsWith(' ')) {
              const text = l === '' ? '' : l.slice(1);
              current.O.push(text);
              current.N.push({ ctx: true, o: current.O.length - 1 });
            } else if (l.startsWith('-')) {
              current.O.push(l.slice(1));
            } else {
              current.N.push({ ctx: false, text: l.slice(1) });
            }
            idx += 1;
            continue;
          }
          throw new Exit2(`error: parse ${idx + 1}`);
        }
        pushCurrent();
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine + 1}`);
        edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      }
      i = v4aSectionEnd(lines, i + 1, last);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k += 1) {
      if (norm(lines[k]!, t) === norm(anchor, t)) return k;
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(model.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (chunk.O.length === 0) {
        const at = chunk.eof ? model.lines.length : cursor;
        const add = buildNew(chunk.N, [], model.lines, at, null);
        model.lines.splice(at, 0, ...add);
        cursor = at + add.length;
      } else {
        const tier = firstTier(model.lines, chunk.O, strict, cursor);
        if (tier === null) throw new Fail('no-match', path);
        const occs = occurrences(model.lines, chunk.O, tier, cursor);
        let pos = -1;
        for (const p of occs) {
          if (chunk.eof && p + chunk.O.length !== model.lines.length) continue;
          pos = p;
          break;
        }
        if (pos < 0) throw new Fail('no-match', path);
        const add = buildNew(chunk.N, chunk.O, model.lines, pos, tier);
        model.lines.splice(pos, chunk.O.length, ...add);
        cursor = pos + add.length;
      }
    }
    const result = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, result);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const mv = tree.snapshotMoves();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.truncateMoves(mv);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.movePairs()) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
