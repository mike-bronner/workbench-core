#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const USAGE = `usage:
  node cut-diff.mjs <original> <new> [--keep-file <file>] [--keep "<passage>"]... [--max-chars <n>] [--max-words <n>]
  node cut-diff.mjs --self-test`;

const NAMES = new Map([
  [0x09, 'tab'],
  [0x0a, 'line break'],
  [0x20, 'space'],
  [0x22, 'straight double quote'],
  [0x27, 'apostrophe'],
  [0x2d, 'hyphen-minus'],
  [0xa0, 'no-break space'],
  [0x2009, 'thin space'],
  [0x200b, 'zero-width space'],
  [0x2010, 'hyphen'],
  [0x2011, 'non-breaking hyphen'],
  [0x2013, 'en dash'],
  [0x2014, 'em dash'],
  [0x2018, 'left single quote'],
  [0x2019, 'right single quote'],
  [0x201c, 'left double quote'],
  [0x201d, 'right double quote'],
  [0x2026, 'ellipsis'],
  [0x202f, 'narrow no-break space'],
  [0x2212, 'minus sign'],
  [0xfeff, 'zero-width no-break space'],
]);

const points = (s) => Array.from(s);
const squash = (s) => s.replace(/\s+/gu, ' ').trim();
const norm = (s) => s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
const fmt = (n) => n.toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const visible = (s) => s.replace(/\n/g, '⏎').replace(/\t/g, '⇥');

function describe(cp) {
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  const ch = String.fromCodePoint(cp);
  const shown = /[\s\p{C}]/u.test(ch) ? '' : `${ch} `;
  const name = NAMES.get(cp);
  return `${shown}${hex}${name ? ` ${name}` : ''}`;
}

function counts(s) {
  const t = s.trim();
  return { chars: points(s).length, utf16: s.length, words: t === '' ? 0 : t.split(/\s+/u).length };
}

const BLOCK_START = /^\s*([-*+•]\s|\d+[.)]\s|#{1,6}\s|>|\|)/;

function sentences(text) {
  const out = [];
  text.split(/\n(?:[ \t]*\n)+/).forEach((para, i) => {
    const units = [];
    for (const line of para.split('\n')) {
      if (units.length > 0 && !BLOCK_START.test(line)) units[units.length - 1] += ` ${line}`;
      else units.push(line);
    }
    for (const unit of units) {
      for (const piece of unit.split(/(?<=[.!?…]["'”’)\]]*)\s+/u)) {
        const t = squash(piece);
        if (t) out.push({ p: i + 1, text: t });
      }
    }
  });
  return out;
}

function missingFrom(text, other) {
  const present = new Set(sentences(other).map((x) => x.text));
  return sentences(text).filter((x) => !present.has(x.text));
}

function closestWindow(P, H) {
  let best = null;
  for (let start = 0; start + P.length <= H.length; start += 1) {
    let misses = 0;
    let first = -1;
    for (let k = 0; k < P.length && (best === null || misses < best.misses); k += 1) {
      if (P[k] !== H[start + k]) {
        misses += 1;
        if (first === -1) first = k;
      }
    }
    if (best === null || misses < best.misses) best = { start, misses, first };
  }
  return best;
}

function longestMatch(P, hay, fromEnd) {
  const piece = (n) => (fromEnd ? P.slice(P.length - n) : P.slice(0, n)).join('');
  let lo = 0;
  let hi = P.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (hay.includes(piece(mid))) lo = mid;
    else hi = mid - 1;
  }
  return { n: lo, text: piece(lo) };
}

function around(arr, i) {
  const a = Math.max(0, i - 15);
  const b = Math.min(arr.length, i + 16);
  return `${a > 0 ? '…' : ''}${visible(arr.slice(a, b).join(''))}${b < arr.length ? '…' : ''}`;
}

function firstDifference(passage, hay) {
  const P = points(passage);
  const head = longestMatch(P, hay, false);
  if (head.n === P.length) return null;
  const tail = longestMatch(P, hay, true);
  const H = points(hay);
  if (Math.max(head.n, tail.n) < 8) {
    const near = P.length <= 64 ? closestWindow(P, H) : null;
    if (near === null || near.misses * 2 > P.length) return { missing: true };
    const at = near.start + near.first;
    return {
      fromEnd: false,
      index: near.first,
      expected: P[near.first].codePointAt(0),
      found: H[at].codePointAt(0),
      keep: around(P, near.first),
      hay: around(H, at),
    };
  }
  if (head.n >= tail.n) {
    const at = points(hay.slice(0, hay.indexOf(head.text))).length + head.n;
    return {
      fromEnd: false,
      index: head.n,
      expected: P[head.n].codePointAt(0),
      found: H[at]?.codePointAt(0),
      keep: around(P, head.n),
      hay: around(H, at),
    };
  }
  const index = P.length - tail.n - 1;
  const at = points(hay.slice(0, hay.indexOf(tail.text))).length - 1;
  return {
    fromEnd: true,
    index,
    expected: P[index].codePointAt(0),
    found: at >= 0 ? H[at].codePointAt(0) : undefined,
    keep: around(P, index),
    hay: around(H, Math.max(at, 0)),
  };
}

function explain(diff, len, where, pad) {
  if (diff === null) return [];
  if (diff.missing) return [`${pad}not found in the ${where} text: it was cut or rewritten`];
  const edge = diff.fromEnd ? 'start' : 'end';
  return [
    `${pad}${diff.fromEnd ? 'last' : 'first'} difference at character ${fmt(diff.index + 1)} of ${fmt(len)}${diff.fromEnd ? ' (the end matches)' : ''}`,
    `${pad}keep      ${diff.keep}`,
    `${pad}${where.padEnd(10)}${diff.hay}`,
    `${pad}expected ${describe(diff.expected)}, found ${diff.found === undefined ? `the ${edge} of the text` : describe(diff.found)}`,
  ];
}

function preview(s) {
  const P = points(s);
  return `"${visible(P.slice(0, 40).join(''))}${P.length > 40 ? '…' : ''}"`;
}

function check({ original, next, keeps = [], maxChars, maxWords }) {
  const lines = [];
  const problems = [];
  const o = counts(original);
  const s = counts(next);
  const removed = o.chars - s.chars;
  const share = o.chars === 0 ? 0 : Math.round((removed * 1000) / o.chars) / 10;

  lines.push('counts');
  lines.push(`  original  ${plural(o.chars, 'character', 'characters')}, ${plural(o.words, 'word', 'words')}`);
  lines.push(
    `  new       ${plural(s.chars, 'character', 'characters')}, ${plural(s.words, 'word', 'words')}` +
      (s.utf16 === s.chars ? '' : ` (UTF-16 length ${fmt(s.utf16)})`),
  );
  lines.push(
    removed >= 0
      ? `  removed   ${plural(removed, 'character', 'characters')} (${share}% of the original)`
      : `  removed   none: the new version is ${plural(-removed, 'character', 'characters')} longer`,
  );
  if (maxChars !== undefined) {
    const left = maxChars - s.chars;
    lines.push(`  limit     ${fmt(maxChars)} characters: ${left >= 0 ? `${fmt(left)} under` : `${fmt(-left)} over`}`);
    if (o.chars > maxChars) lines.push(`            to fit, at least ${plural(o.chars - maxChars, 'character', 'characters')} of the original must go`);
    if (left < 0) problems.push(`${plural(-left, 'character', 'characters')} over the limit`);
  }
  if (maxWords !== undefined) {
    const left = maxWords - s.words;
    lines.push(`  limit     ${fmt(maxWords)} words: ${left >= 0 ? `${fmt(left)} under` : `${fmt(-left)} over`}`);
    if (left < 0) problems.push(`${plural(-left, 'word', 'words')} over the limit`);
  }

  lines.push('keep');
  if (keeps.length === 0) {
    lines.push('  none given. If the person named a passage to keep exactly, put it in a keep file and run this again.');
  }
  keeps.forEach((keep, i) => {
    const n = i + 1;
    const head = `  ${n}  `;
    const pad = ' '.repeat(head.length + 6);
    const len = points(keep).length;
    if (!original.includes(keep)) {
      problems.push(`keep ${n} is not in the original`);
      lines.push(`${head}FAIL  not in the original exactly: copy it from the original file, do not retype it`);
      lines.push(...explain(firstDifference(keep, original), len, 'original', pad));
      return;
    }
    if (next.includes(keep)) {
      lines.push(`${head}ok    ${preview(keep)} (${plural(len, 'character', 'characters')})`);
      return;
    }
    const spacing = squash(next).includes(squash(keep));
    problems.push(`keep ${n} ${spacing ? 'has different spacing' : 'changed or cut'}`);
    lines.push(`${head}FAIL  ${spacing ? 'matches only if spaces and line breaks are ignored' : 'changed or cut'}`);
    lines.push(...explain(firstDifference(keep, next), len, 'new', pad));
  });

  const cut = missingFrom(original, next);
  const added = missingFrom(next, original);
  lines.push(
    cut.length === 0
      ? 'cut: every sentence of the original is in the new version'
      : `cut: ${plural(cut.length, 'sentence', 'sentences')} of the original ${cut.length === 1 ? 'is' : 'are'} not in the new version`,
  );
  for (const x of cut) lines.push(`  - p${x.p}  ${visible(x.text)}`);
  lines.push(
    added.length === 0
      ? 'new wording: none'
      : `new wording: ${plural(added.length, 'sentence', 'sentences')} of the new version ${added.length === 1 ? 'is' : 'are'} not in the original`,
  );
  for (const x of added) lines.push(`  + p${x.p}  ${visible(x.text)}`);

  const ok = problems.length === 0;
  lines.push(ok ? 'result: ok' : `result: FAIL (${problems.join('; ')})`);
  lines.push(
    ok
      ? 'next: show the person the counts, the keep check and the cut list before you send or save the new version.'
      : 'next: fix each FAIL (for a keep passage, change only the characters shown), then run this again.',
  );
  return { ok, lines, cut, added };
}

const parseKeepFile = (text) =>
  text
    .split(/^---[ \t]*$/m)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p !== '');

function wholeNumber(value, flag) {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 0) throw new Error(`${flag} takes a whole number`);
  return n;
}

async function readInside(path) {
  const cwd = await realpath(process.cwd());
  let real;
  try {
    real = await realpath(resolve(cwd, path));
  } catch {
    throw new Error(`cannot read ${path}: no such file`);
  }
  const rel = relative(cwd, real);
  const inCwd = !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  if (!inCwd && !inScratchpad(real)) {
    throw new Error(
      `${path} is outside the working folder (${cwd}) and the session scratchpad. Ask the user before reading it. If the user agrees, copy it into the session scratchpad and run this again.`,
    );
  }
  return readFile(real, 'utf8');
}

function inScratchpad(real, sid = process.env.CLAUDE_CODE_SESSION_ID, uid = process.getuid?.()) {
  if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid) || uid === undefined) return false;
  const m = real.match(/^(?:\/private)?\/tmp\/claude-(\d+)\/[^/]+\/([^/]+)\/scratchpad(?:\/|$)/);
  return Boolean(m) && m[1] === String(uid) && m[2] === sid;
}

function selfTest() {
  const original = norm(
    'Status for Tuesday.\n\nThe build is green. We moved the release to Thursday.\n\n' +
      'Deploy freeze: nothing ships after 16:00 on Friday, and we don’t merge without a review.\n\nLunch is at noon.\n',
  );
  const keep = 'Deploy freeze: nothing ships after 16:00 on Friday, and we don’t merge without a review.';
  const bad = "Release moved to Thursday.\n\nDeploy freeze: nothing ships after 16:00 on Friday, and we don't merge without a review.";
  const good = bad.replace("don't", 'don’t');

  const b = check({ original, next: bad, keeps: [keep], maxChars: 200 });
  assert.equal(b.ok, false);
  assert.ok(b.lines.some((l) => l.includes("expected ’ U+2019 right single quote, found ' U+0027 apostrophe")));
  assert.ok(b.lines.some((l) => l.includes('first difference at character 63 of 88')));

  const g = check({ original, next: good, keeps: [keep], maxChars: 200, maxWords: 30 });
  assert.equal(g.ok, true);
  assert.deepEqual(
    g.cut.map((x) => x.text),
    ['Status for Tuesday.', 'The build is green.', 'We moved the release to Thursday.', 'Lunch is at noon.'],
  );
  assert.deepEqual(g.added.map((x) => x.text), ['Release moved to Thursday.']);
  assert.ok(g.lines.includes('  new       116 characters, 19 words'));
  assert.ok(g.lines.includes('  limit     200 characters: 84 under'));
  assert.ok(g.lines.includes('  limit     30 words: 11 under'));
  assert.ok(g.lines.includes('  - p1  Status for Tuesday.'));

  const over = check({ original, next: good, keeps: [keep], maxChars: 50 });
  assert.equal(over.ok, false);
  assert.ok(over.lines.at(-2).includes('66 characters over the limit'));
  const wordy = check({ original, next: good, maxWords: 18 });
  assert.equal(wordy.ok, false);
  assert.ok(wordy.lines.at(-2).includes('1 word over the limit'));
  assert.equal(check({ original, next: good, maxWords: 19 }).ok, true);
  assert.equal(check({ original, next: good, maxChars: 116 }).ok, true);

  const retyped = check({ original, next: good, keeps: [keep.replace('’', "'")] });
  assert.equal(retyped.ok, false);
  assert.ok(retyped.lines.some((l) => l.includes('not in the original exactly')));

  const spaced = check({ original, next: good.replace('16:00 on', '16:00\non'), keeps: [keep] });
  assert.equal(spaced.ok, false);
  assert.ok(spaced.lines.some((l) => l.includes('expected U+0020 space, found U+000A line break')));

  const dropped = check({ original, next: 'Release moved to Thursday.', keeps: [keep] });
  assert.equal(dropped.ok, false);
  assert.ok(dropped.lines.some((l) => l.includes('not found in the new text: it was cut or rewritten')));

  const short = check({ original: 'Say don’t x now.', next: "Say don't x now.", keeps: ['don’t x'] });
  assert.equal(short.ok, false);
  assert.ok(short.lines.some((l) => l.includes("expected ’ U+2019 right single quote, found ' U+0027 apostrophe")));
  assert.ok(short.lines.some((l) => l.includes('first difference at character 4 of 7')));
  const tiny = check({ original: 'A b.', next: 'C d.', keeps: ['A'] });
  assert.ok(tiny.lines.some((l) => l.includes('not found in the new text')));

  const inside = check({ original: 'Do ship it.', next: 'Do not ship it. BOOK.' });
  assert.deepEqual(inside.cut.map((x) => x.text), ['Do ship it.']);
  const nested = check({ original: 'It ships Friday.', next: 'Nobody says It ships Friday.' });
  assert.deepEqual(nested.cut.map((x) => x.text), ['It ships Friday.']);
  assert.deepEqual(nested.added.map((x) => x.text), ['Nobody says It ships Friday.']);
  const wrapped = check({ original: 'The release moves to\nThursday. Lunch is\nat noon.', next: 'The release moves to Thursday.' });
  assert.deepEqual(wrapped.cut.map((x) => x.text), ['Lunch is at noon.']);
  assert.deepEqual(wrapped.added, []);
  const fragment = check({ original: 'We will ship\nnothing on Friday.', next: 'We will ship.' });
  assert.deepEqual(fragment.cut.map((x) => x.text), ['We will ship nothing on Friday.']);
  assert.deepEqual(
    sentences('Plan\n- first item\n- second item\n# Next\ntext').map((x) => x.text),
    ['Plan', '- first item', '- second item', '# Next text'],
  );

  assert.equal(inScratchpad('/private/tmp/claude-503/-Users-x/abc-1/scratchpad/cut/a.txt', 'abc-1', 503), true);
  assert.equal(inScratchpad('/private/tmp/claude-503/-Users-x/other/scratchpad/a.txt', 'abc-1', 503), false);
  assert.equal(inScratchpad('/private/tmp/claude-504/-Users-x/abc-1/scratchpad/a.txt', 'abc-1', 503), false);
  assert.equal(inScratchpad('/private/tmp/claude-503/-Users-x/abc-1/scratchpad/a.txt', '', 503), false);

  const whole = check({ original, next: original });
  assert.deepEqual(whole.cut, []);
  assert.ok(whole.lines.includes('cut: every sentence of the original is in the new version'));

  assert.equal(counts('a 😀 b').chars, 5);
  assert.equal(counts('a 😀 b').utf16, 6);
  assert.equal(counts('   ').words, 0);
  assert.equal(norm('\uFEFFa\r\nb\n'), 'a\nb');
  assert.deepEqual(parseKeepFile('one\n---\n\ntwo\nlines\n---\n'), ['one', 'two\nlines']);
  assert.throws(() => wholeNumber('-1', '--max-chars'));
  assert.throws(() => wholeNumber('', '--max-chars'));
  console.log('self-test ok');
  return 0;
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const files = [];
  const keeps = [];
  let keepFile;
  let maxChars;
  let maxWords;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
      return argv[i];
    };
    if (a === '--keep') keeps.push(norm(value()));
    else if (a === '--keep-file') keepFile = value();
    else if (a === '--max-chars') maxChars = wholeNumber(value(), a);
    else if (a === '--max-words') maxWords = wholeNumber(value(), a);
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else files.push(a);
  }
  if (files.length !== 2) throw new Error(`give the original and the new version\n${USAGE}`);
  const [original, next] = (await Promise.all(files.map(readInside))).map(norm);
  if (keepFile !== undefined) keeps.unshift(...parseKeepFile(norm(await readInside(keepFile))));
  const result = check({ original, next, keeps, maxChars, maxWords });
  console.log(result.lines.join('\n'));
  return result.ok ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`cut-diff: ${error.message}`);
  process.exitCode = 1;
}
