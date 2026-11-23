// A faster drop-in for makefun-site 1.0.0, written from scratch in this session
// from the behaviour its README states and its reference code shows: the same
// front matter, slug rule, Markdown subset, template dialect and report, byte
// for byte. No dependency, no I/O, no clock, no randomness: run(input) is a
// pure function of its input, one case at a time.
//
// How it is fast:
// - Markdown is rendered in one fused pass over the body string, with a cursor
//   over line ranges instead of a split lines array; inline rendering works on
//   character ranges, so nested strong/emphasis/link content is never sliced
//   into throwaway strings, and plain-text runs are flushed through the HTML
//   escape in bulk.
// - The escape itself takes a fast path: a string with no escapable character
//   is returned untouched, and ranges are escaped with one native regex scan.
// - Slugs and long dates are cached per case (tag names repeat constantly);
//   word counting is a single allocation-free scan instead of a regex match.
// - Front matter is scanned line by line without splitting the body, and the
//   body is handed to the Markdown renderer as one slice.
// - Templates are compiled once per case into plain JavaScript functions
//   (new Function over generated code): paths resolve against statically
//   known loop bindings, includes are direct calls, and rendering is a flat
//   sequence of pushes into one output array. A template that only reads
//   the site, its tags and its recent posts renders the same in every
//   render of the case, so it is rendered once and reused. Nothing is
//   cached from one case to the next: every case parses and compiles its
//   own templates.

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped; untouched when it holds none of them. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/**
 * `s[a..b)` escaped into `out`. One native regex scan from `a`; a range with
 * no escapable character costs that scan plus one slice.
 */
function escapeRangeInto(s, a, b, out) {
  if (a >= b) return;
  ESC_RE.lastIndex = a;
  let cur = a;
  let m;
  while ((m = ESC_RE.exec(s)) !== null && m.index < b) {
    if (m.index > cur) out.push(s.slice(cur, m.index));
    out.push(ESCAPES[m[0]]);
    cur = m.index + 1;
  }
  if (b > cur) out.push(s.slice(cur, b));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The slug of `src[a..b)` after normalising: NFKD, combining marks dropped,
 * A-Z lowered, every run of characters other than a-z and 0-9 one "-",
 * none at either end, at most 64 characters (a "-" left at the cut dropped),
 * and "untitled" when nothing is left. A kept character is lowered by
 * arithmetic, not by a case call.
 */
function buildSlug(src, a, b) {
  let out = '';
  let gap = false;
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`. Pure ASCII text skips the normalise step entirely. */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  return buildSlug(plain, 0, plain.length);
}

/**
 * The slug of `src[a..b)`, without slicing it: one pass while the range is
 * ASCII, and the normal slugify (which normalises the whole range) when a
 * non-ASCII character appears.
 */
function slugifyRange(src, a, b) {
  let out = '';
  let gap = false;
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c > 127) return slugify(src.slice(a, b));
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether char code `c` is whitespace in JavaScript's \s sense. */
function isWsCode(c) {
  return (c >= 9 && c <= 13) || c === 32 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || (c >= 9 && c <= 13);
    else ws = isWsCode(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** `s` with trailing spaces and tabs dropped. */
function stripTrailing(s) {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return s.slice(0, end);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One front-matter line into `data`, or the reason it refuses the source
 * (null when the line is blank, a comment, or a good key line). `lineNo` is
 * counted from 1 at the opening `---`.
 */
function fmLine(line, lineNo, data) {
  if (line.length === 0) return null;
  const c0 = line.charCodeAt(0);
  if (c0 === 35) return null;
  if ((c0 === 32 || c0 === 9) && isBlankLine(line)) return null;
  const ci = line.indexOf(':');
  if (ci <= 0) return `line ${lineNo} is not "key: value"`;
  for (let k = 0; k < ci; k++) {
    const c = line.charCodeAt(k);
    if (!((c >= 97 && c <= 122) || c === 95)) return `line ${lineNo} is not "key: value"`;
  }
  const rest = line.slice(ci + 1);
  let raw;
  if (rest === '') raw = '';
  else if (rest.charCodeAt(0) === 32) raw = stripTrailing(rest.slice(1));
  else return `line ${lineNo} is not "key: value"`;
  const key = line.slice(0, ci);
  if (!KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = keyValue(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Only the front
 * matter region is walked line by line; the body is one slice.
 */
function parseFrontMatter(text) {
  const n = text.length;
  let nl = text.indexOf('\n', 0);
  const firstEnd = nl === -1 ? n : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  let pos = nl === -1 ? n : nl + 1;
  let lineNo = 2;
  const data = {};
  let closed = false;
  while (pos <= n) {
    nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const line = text.slice(pos, lineEnd);
    if (line === '---') {
      closed = true;
      pos = nl === -1 ? n : nl + 1;
      break;
    }
    const err = fmLine(line, lineNo, data);
    if (err !== null) return { error: err };
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (!closed) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(pos) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = '\\`*_[]()#+-.!>';
const WS_RE = /\s/;

/** Whether the line `src[pos..le)` is blank (spaces and tabs only). */
function blankAt(src, pos, le) {
  for (let k = pos; k < le; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `c` is a fence language character (A-Z, a-z, 0-9, _, +, -). */
function isLangCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/**
 * The fence language when the line `src[pos..le)` opens a fence, else null
 * ("" for a bare fence).
 */
function fenceLangAt(src, pos, le) {
  if (src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) return null;
  let j = pos + 3;
  while (j < le && isLangCode(src.charCodeAt(j))) j++;
  for (let k = j; k < le; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return src.slice(pos + 3, j);
}

/** Whether the line `src[pos..le)` closes a fence. */
function isFenceCloseAt(src, pos, le) {
  if (src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) return false;
  for (let k = pos + 3; k < le; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading line's level and text range, or null (a heading's text is never
 * empty). `ts`/`te` bound the text with its trailing spaces and tabs dropped.
 */
function headingAt(src, pos, le) {
  let depth = 0;
  while (pos + depth < le && src.charCodeAt(pos + depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  let j = pos + depth;
  if (j >= le || (src.charCodeAt(j) !== 32 && src.charCodeAt(j) !== 9)) return null;
  while (j < le && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
  let te = le;
  while (te > j && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
  if (te === j) return null;
  return { depth, ts: j, te };
}

/** Whether the line `src[pos..le)` is a thematic break. */
function isHrAt(src, pos, le) {
  const c0 = src.charCodeAt(pos);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(pos + 1) !== c0 || src.charCodeAt(pos + 2) !== c0) return false;
  for (let k = pos + 3; k < le; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether the line `src[pos..le)` ends a paragraph. */
function endsParagraphAt(src, pos, le) {
  if (le === pos) return true;
  const c0 = src.charCodeAt(pos);
  if (c0 === 32 || c0 === 9) return blankAt(src, pos, le);
  if (c0 === 96) return fenceLangAt(src, pos, le) !== null;
  if (c0 === 35) return headingAt(src, pos, le) !== null;
  if (c0 === 45 || c0 === 42) return isHrAt(src, pos, le);
  return false;
}

/** `src[a..b)` with spaces and tabs at either end dropped, as [start, end). */
function trimRange(src, a, b) {
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return [a, b];
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const last = end - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s[j] !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that can open an inline construct, or need HTML escaping. */
const INLINE_RE = /[\\`*\[]|[&<>"']/g;
const ESC_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * `s[a..b)` rendered inline into `out`; `link(target)` is a link's href.
 * Works on ranges throughout, so nested constructs never copy their text.
 * One native regex jump finds the next construct or escapable character, so
 * a plain run between two stops holds no escapable character and goes out
 * as a single slice — the text is scanned once, not once for constructs and
 * again for escaping (lastIndex is reset on every step, so the recursion
 * through nested constructs cannot disturb the search).
 */
function inlineInto(s, a, b, link, out) {
  let plain = a;
  let i = a;
  while (i < b) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null || m.index >= b) break;
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > plain) out.push(s.slice(plain, i));
      out.push(ESC_ENT[s[i]]);
      i++;
      plain = i;
      continue;
    }
    if (c === 92 && i + 1 < b && ESCAPABLE.indexOf(s[i + 1]) !== -1) {
      if (i > plain) out.push(s.slice(plain, i));
      out.push(s[i + 1]);
      i += 2;
      plain = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > plain) out.push(s.slice(plain, i));
        out.push('<code>');
        escapeRangeInto(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          if (i > plain) out.push(s.slice(plain, i));
          out.push('<strong>');
          inlineInto(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        if (i > plain) out.push(s.slice(plain, i));
        out.push('<em>');
        inlineInto(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m2 = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        const p = s.indexOf(')', k + 2);
        if (p !== -1 && p < b) m2 = p;
      }
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > plain) out.push(s.slice(plain, i));
        const href = link(target);
        out.push('<a href="');
        escapeRangeInto(href, 0, href.length, out);
        out.push('">');
        inlineInto(s, i + 1, k, link, out);
        out.push('</a>');
        i = m2 + 1;
        plain = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (b > plain) out.push(s.slice(plain, b));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Lines are walked with a cursor over ranges, never split into an array.
 */
function renderMarkdown(src, link) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  let le = src.indexOf('\n', 0);
  if (le === -1) le = n;
  while (pos <= n) {
    if (blankAt(src, pos, le)) {
      pos = le + 1;
      if (pos <= n) {
        le = src.indexOf('\n', pos);
        if (le === -1) le = n;
      }
      continue;
    }
    const c0 = src.charCodeAt(pos);
    if (c0 === 96) {
      const lang = fenceLangAt(src, pos, le);
      if (lang !== null) {
        out.push('<pre><code');
        if (lang !== '') {
          out.push(' class="language-');
          out.push(escapeHtml(lang));
          out.push('"');
        }
        out.push('>');
        pos = le + 1;
        if (pos <= n) {
          le = src.indexOf('\n', pos);
          if (le === -1) le = n;
        }
        // The fence's content as one range: escaping distributes over the
        // "\n" between its lines, so one slice and one escape replace a
        // slice, an escape and two pushes per line.
        const contentStart = pos;
        let contentEnd = pos;
        while (pos <= n && !isFenceCloseAt(src, pos, le)) {
          contentEnd = le;
          pos = le + 1;
          if (pos <= n) {
            le = src.indexOf('\n', pos);
            if (le === -1) le = n;
          }
        }
        if (contentEnd > contentStart) {
          out.push(escapeHtml(src.slice(contentStart, contentEnd)));
          out.push('\n');
        }
        if (pos <= n) {
          pos = le + 1;
          if (pos <= n) {
            le = src.indexOf('\n', pos);
            if (le === -1) le = n;
          }
        }
        out.push('</code></pre>', '\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingAt(src, pos, le);
      if (h !== null) {
        const id = uniqueSlug(slugifyRange(src, h.ts, h.te), ids);
        if (h.depth === 2 || h.depth === 3) {
          const tmp = [];
          inlineInto(src, h.ts, h.te, link, tmp);
          const html = tmp.join('');
          out.push(`<h${h.depth} id="${id}">`, html, `</h${h.depth}>`, '\n');
          toc.push({ level: h.depth, id, html });
        } else {
          out.push(`<h${h.depth} id="${id}">`);
          inlineInto(src, h.ts, h.te, link, out);
          out.push(`</h${h.depth}>`, '\n');
        }
        pos = le + 1;
        if (pos <= n) {
          le = src.indexOf('\n', pos);
          if (le === -1) le = n;
        }
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHrAt(src, pos, le)) {
        out.push('<hr>', '\n');
        pos = le + 1;
        if (pos <= n) {
          le = src.indexOf('\n', pos);
          if (le === -1) le = n;
        }
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      while (pos <= n && src.charCodeAt(pos) === 62) {
        let a = pos + 1;
        if (a < le && src.charCodeAt(a) === 32) a++;
        const [s, e] = trimRange(src, a, le);
        if (e > s) parts.push(src.slice(s, e));
        pos = le + 1;
        if (pos <= n) {
          le = src.indexOf('\n', pos);
          if (le === -1) le = n;
        }
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        const text = parts.join('\n');
        const tmp = [];
        inlineInto(text, 0, text.length, link, tmp);
        out.push('<blockquote>\n<p>', tmp.join(''), '</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const b0 = c0;
    const bullet = (b0 === 45 || b0 === 42) && src.charCodeAt(pos + 1) === 32;
    let ordered = false;
    let start = 1;
    let digits = 0;
    if (!bullet) {
      while (pos + digits < le) {
        const c = src.charCodeAt(pos + digits);
        if (c < 48 || c > 57) break;
        digits++;
      }
      if (digits >= 1 && digits <= 9 && src.charCodeAt(pos + digits) === 46 && src.charCodeAt(pos + digits + 1) === 32) {
        ordered = true;
        start = Number(src.slice(pos, pos + digits));
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (pos <= n) {
        const l0 = src.charCodeAt(pos);
        if (bullet) {
          if ((l0 === 45 || l0 === 42) && src.charCodeAt(pos + 1) === 32) {
            const [s, e] = trimRange(src, pos + 2, le);
            items.push([src.slice(s, e)]);
            pos = le + 1;
            if (pos <= n) {
              le = src.indexOf('\n', pos);
              if (le === -1) le = n;
            }
            continue;
          }
        } else {
          let d = 0;
          while (pos + d < le) {
            const c = src.charCodeAt(pos + d);
            if (c < 48 || c > 57) break;
            d++;
          }
          if (d >= 1 && d <= 9 && src.charCodeAt(pos + d) === 46 && src.charCodeAt(pos + d + 1) === 32) {
            const [s, e] = trimRange(src, pos + d + 2, le);
            items.push([src.slice(s, e)]);
            pos = le + 1;
            if (pos <= n) {
              le = src.indexOf('\n', pos);
              if (le === -1) le = n;
            }
            continue;
          }
        }
        let sp = 0;
        while (pos + sp < le && src.charCodeAt(pos + sp) === 32) sp++;
        if (sp >= 2 && pos + sp < le && !isWsCode(src.charCodeAt(pos + sp))) {
          const [s, e] = trimRange(src, pos, le);
          items[items.length - 1].push(src.slice(s, e));
          pos = le + 1;
          if (pos <= n) {
            le = src.indexOf('\n', pos);
            if (le === -1) le = n;
          }
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const item of items) {
        const text = item.join('\n');
        const tmp = [];
        inlineInto(text, 0, text.length, link, tmp);
        out.push('<li>', tmp.join(''), '</li>\n');
      }
      out.push(`</${tag}>`, '\n');
      continue;
    }
    const [s0, e0] = trimRange(src, pos, le);
    pos = le + 1;
    if (pos <= n) {
      le = src.indexOf('\n', pos);
      if (le === -1) le = n;
    }
    let parts = null;
    while (pos <= n && !endsParagraphAt(src, pos, le)) {
      if (parts === null) parts = [src.slice(s0, e0)];
      const [s, e] = trimRange(src, pos, le);
      parts.push(src.slice(s, e));
      pos = le + 1;
      if (pos <= n) {
        le = src.indexOf('\n', pos);
        if (le === -1) le = n;
      }
    }
    if (parts === null) {
      // A one-line paragraph renders straight off the body's range: no
      // slice, no join.
      if (excerpt === null) {
        const tmp = [];
        inlineInto(src, s0, e0, link, tmp);
        excerpt = tmp.join('');
        out.push('<p>', excerpt, '</p>', '\n');
      } else {
        out.push('<p>');
        inlineInto(src, s0, e0, link, out);
        out.push('</p>', '\n');
      }
    } else {
      const text = parts.join('\n');
      if (excerpt === null) {
        const tmp = [];
        inlineInto(text, 0, text.length, link, tmp);
        excerpt = tmp.join('');
        out.push('<p>', excerpt, '</p>', '\n');
      } else {
        out.push('<p>');
        inlineInto(text, 0, text.length, link, out);
        out.push('</p>', '\n');
      }
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces or tabs. */
function onlySpacesTabs(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpacesTabs(src, lineStart, open) && onlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds: 0 text, 1 var, 2 raw, 3 for, 4 if, 5 include; 6 is the root.
/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 6, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, t: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? 1 : 2, p: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 3, name: m[1], p: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 4, not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 4 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 3 : 4)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 6 ? parent.body : parent.k === 3 ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 3 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** Every for-bound name in `nodes`, into `set` (for the shared scope object). */
function collectForNames(nodes, set) {
  for (const nd of nodes) {
    if (nd.k === 3) {
      set.add(nd.name);
      collectForNames(nd.body, set);
    } else if (nd.k === 4) {
      collectForNames(nd.then, set);
      if (nd.els !== null) collectForNames(nd.els, set);
    }
  }
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function getProp(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The names a render's top-level vars object always carries. */
const TOP_NAMES = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

/**
 * The JavaScript expression for `path`. The first name resolves by the
 * shape of the scope, which is fixed per case:
 * - a name some template binds in a for reads its slot in the shared scope
 *   object S (an element while a loop binding it is live, undefined
 *   otherwise; the loop's save/restore keeps that exact), falling back to
 *   the top-level vars only where the name is also one of those;
 * - a top-level name reads its slot in V directly (a plain object whose
 *   keys are exactly these names, so a missing one reads undefined);
 * - any other name reads nothing, so it is undefined outright.
 * Later names go through getProp, which keeps the reference's own-property
 * rule (a value that is null or not an object ends the path). Includes
 * render in their caller's scope, so the S slots are exactly what an
 * included template must see.
 */
function pathExpr(path, loopNames) {
  const a = path[0];
  let e;
  if (loopNames.has(a)) e = TOP_NAMES.has(a) ? `(S.${a}!==undefined?S.${a}:V.${a})` : `S.${a}`;
  else if (TOP_NAMES.has(a)) e = `V.${a}`;
  else e = 'undefined';
  for (let k = 1; k < path.length; k++) e = `g(${e},${JSON.stringify(path[k])})`;
  return e;
}

/**
 * `nodes` compiled into a render function (out, V, T, D, S, g, esc, txt, tru, C).
 * A for saves the slots it binds and restores them after the loop, so the
 * flat scope object S behaves exactly like the reference's chain of scopes,
 * including through includes, which receive the same S. C holds the
 * pre-rendered output of the case-constant templates (see `constInfo`):
 * an include of one reuses it while the include-depth limit cannot cut a
 * nested include off, and renders in place otherwise.
 */
function compileTemplate(nodes, loopNames, constInfo) {
  const parts = [];
  let uid = 0;
  const gen = (list) => {
    for (const nd of list) {
      if (nd.k === 0) parts.push(`out.push(${JSON.stringify(nd.t)});`);
      else if (nd.k === 1) parts.push(`out.push(esc(txt(${pathExpr(nd.p, loopNames)})));`);
      else if (nd.k === 2) parts.push(`out.push(txt(${pathExpr(nd.p, loopNames)}));`);
      else if (nd.k === 3) {
        const u = uid++;
        const px = pathExpr(nd.p, loopNames);
        // One loop object per for, mutated per iteration: a template only
        // reads loop.index/first/last/length, and the save/restore below
        // keeps a nested for from disturbing the outer one.
        parts.push(`{const _x${u}=${px};if(Array.isArray(_x${u})){const _a${u}=S.${nd.name},_b${u}=S.loop;const _l${u}={index:0,first:false,last:false,length:_x${u}.length};S.loop=_l${u};for(let _k${u}=0;_k${u}<_x${u}.length;_k${u}++){S.${nd.name}=_x${u}[_k${u}];_l${u}.index=_k${u}+1;_l${u}.first=_k${u}===0;_l${u}.last=_k${u}===_x${u}.length-1;`);
        gen(nd.body);
        parts.push(`}S.${nd.name}=_a${u};S.loop=_b${u};}}`);
      } else if (nd.k === 4) {
        parts.push(nd.not ? `if(!tru(${pathExpr(nd.p, loopNames)})){` : `if(tru(${pathExpr(nd.p, loopNames)})){`);
        gen(nd.then);
        if (nd.els !== null) {
          parts.push('}else{');
          gen(nd.els);
        }
        parts.push('}');
      } else if (nd.k === 5) {
        const u = uid++;
        const m = constInfo.get(nd.name);
        if (m !== undefined) {
          parts.push(`{if(D+${m}<${INCLUDE_DEPTH})out.push(C.get(${JSON.stringify(nd.name)}));else{const _f${u}=T.get(${JSON.stringify(nd.name)});if(_f${u}!==undefined&&D<${INCLUDE_DEPTH})_f${u}(out,V,T,D+1,S,g,esc,txt,tru,C);}}`);
        } else {
          parts.push(`{const _f${u}=T.get(${JSON.stringify(nd.name)});if(_f${u}!==undefined&&D<${INCLUDE_DEPTH})_f${u}(out,V,T,D+1,S,g,esc,txt,tru,C);}`);
        }
      }
    }
  };
  gen(nodes);
  return new Function('out', 'V', 'T', 'D', 'S', 'g', 'esc', 'txt', 'tru', 'C', parts.join(''));
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (rel !== '.' && rel !== '..' && !rel.startsWith('./') && !rel.startsWith('../') && !rel.startsWith('/') &&
    rel.indexOf('/./') === -1 && rel.indexOf('/../') === -1 && !rel.endsWith('/.') && !rel.endsWith('/..') &&
    rel.indexOf('//') === -1 && !rel.endsWith('/')) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** Whether `t` holds a scheme (`https:`, `mailto:` ...). */
function isSchemeTarget(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const broken = new Set();
  const slugCache = new Map();
  const dateCache = new Map();
  const linkCache = new Map();
  const slugOf = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugify(text);
      slugCache.set(text, s);
    }
    return s;
  };
  const longOf = (date) => {
    let s = dateCache.get(date);
    if (s === undefined) {
      s = longDate(date);
      dateCache.set(date, s);
    }
    return s;
  };

  // Templates: parsed in code-unit order of name, then compiled. A template
  // that does not parse is reported and left out, as if it were not there.
  const parsed = new Map();
  const loopNames = new Set(['loop']);
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      parsed.set(name, nodes);
      collectForNames(nodes, loopNames);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // A template whose output depends only on the case's site, tags and
  // recent — never on a page, its posts, its pager or a tag, and never on a
  // loop binding from a caller — renders the same in every render of the
  // case, so it is rendered once and reused. `constInfo` maps such a
  // template to the longest chain of includes below it; the cached output
  // is only reused where the include-depth limit cannot cut a nested
  // include off (an include at depth D is complete exactly when D + m < 8).
  // A template in an include cycle, or one whose include chain runs past
  // the depth limit, is left dynamic: rendering it fresh is always right.
  const CONST_TOP = new Set(['site', 'tags', 'recent']);
  const constInfo = new Map();
  const constDone = new Set();
  const nodesConst = (list, bound, visiting) => {
    for (const nd of list) {
      if (nd.k === 0) continue;
      if (nd.k === 1 || nd.k === 2 || nd.k === 4) {
        if (!CONST_TOP.has(nd.p[0]) && !bound.has(nd.p[0])) return false;
        if (nd.k === 4) {
          if (!nodesConst(nd.then, bound, visiting)) return false;
          if (nd.els !== null && !nodesConst(nd.els, bound, visiting)) return false;
        }
      } else if (nd.k === 3) {
        if (!CONST_TOP.has(nd.p[0]) && !bound.has(nd.p[0])) return false;
        const inner = new Set(bound);
        inner.add(nd.name);
        inner.add('loop');
        if (!nodesConst(nd.body, inner, visiting)) return false;
      } else if (nd.k === 5) {
        if (!templateConst(nd.name, visiting)) return false;
      }
    }
    return true;
  };
  const templateConst = (name, visiting) => {
    if (constDone.has(name)) return constInfo.has(name);
    if (visiting.has(name)) return false;
    const nodes = parsed.get(name);
    if (nodes === undefined) return false;
    visiting.add(name);
    const ok = nodesConst(nodes, new Set(), visiting);
    visiting.delete(name);
    constDone.add(name);
    if (ok) {
      let m = 0;
      const depth = (list) => {
        for (const nd of list) {
          if (nd.k === 3) depth(nd.body);
          else if (nd.k === 4) {
            depth(nd.then);
            if (nd.els !== null) depth(nd.els);
          } else if (nd.k === 5) {
            const cm = constInfo.get(nd.name);
            if (cm !== undefined) m = Math.max(m, 1 + cm);
          }
        }
      };
      depth(nodes);
      if (m <= INCLUDE_DEPTH) constInfo.set(name, m);
    }
    return ok;
  };
  for (const name of parsed.keys()) templateConst(name, new Set());
  // The constant templates in dependency order, leaves first, so a
  // pre-render finds every constant include already rendered.
  const constOrder = [];
  const constSeen = new Set();
  const visitConst = (name) => {
    if (constSeen.has(name) || !constInfo.has(name)) return;
    constSeen.add(name);
    const inc = new Set();
    const collect = (list) => {
      for (const nd of list) {
        if (nd.k === 3) collect(nd.body);
        else if (nd.k === 4) {
          collect(nd.then);
          if (nd.els !== null) collect(nd.els);
        } else if (nd.k === 5) inc.add(nd.name);
      }
    };
    collect(parsed.get(name));
    for (const u of inc) visitConst(u);
    constOrder.push(name);
  };
  for (const name of constInfo.keys()) visitConst(name);
  const templates = new Map();
  for (const [name, nodes] of parsed) templates.set(name, compileTemplate(nodes, loopNames, constInfo));
  const constOut = new Map();
  const S = Object.create(null);
  for (const nm of loopNames) S[nm] = undefined;
  const renderTemplate = (name, V) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn(out, V, templates, 0, S, getProp, escapeHtml, textOf, truthy, constOut);
    return out.join('');
  };

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  // and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files
  // they name. A link's answer depends on its directory and target alone, so
  // it is cached per case (null marks a broken one, whose report line still
  // names the source that holds it). One link closure serves the whole case:
  // the directory and source it resolves for are set before each body.
  const staticPaths = new Set(statics.map((f) => f.path));
  const resolveLink = (dir, srcPath, target) => {
    let byDir = linkCache.get(dir);
    if (byDir === undefined) {
      byDir = new Map();
      linkCache.set(dir, byDir);
    }
    const hit = byDir.get(target);
    if (hit !== undefined) {
      if (hit === null) broken.add(`broken-link ${srcPath} -> ${target}`);
      return hit === null ? target : hit;
    }
    let href = target;
    if (!isSchemeTarget(target) && !target.startsWith('/') && !target.startsWith('#')) {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      let done = false;
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) {
          href = `${pg.url}${frag}`;
          done = true;
        } else if (staticPaths.has(path)) {
          href = `${base}/${path}${frag}`;
          done = true;
        }
      }
      if (!done) {
        byDir.set(target, null);
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      }
    }
    byDir.set(target, href);
    return href;
  };
  let curDir = '';
  let curSrc = '';
  const link = (target) => resolveLink(curDir, curSrc, target);
  for (const s of sources) {
    curDir = dirOf(s.path);
    curSrc = s.path;
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older
  // neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTagNames(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [], link: { name, slug, url: `${base}/tags/${slug}/` } };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTagNames(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [], link: { name, slug, url: '' } });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it; a page as its layout reads it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => t.link),
  });
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longOf(s.data.date),
  });
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => t.link),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs. One vars object serves the whole case: its fixed slots
  // (site, tags, recent) never change, and the page's own slots are set
  // before each render and cleared after, so a render never sees another
  // render's page, posts, pager or tag.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const V = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  // The case-constant templates, rendered once into constOut (leaves
  // first, so every constant include they hold is already there).
  for (const name of constOrder) {
    const fn = templates.get(name);
    if (fn === undefined) continue;
    const out = [];
    fn(out, V, templates, 0, S, getProp, escapeHtml, textOf, truthy, constOut);
    constOut.set(name, out.join(''));
  }
  for (const s of sources) {
    V.page = pageOf(s);
    V.posts = undefined;
    V.pager = undefined;
    V.tag = undefined;
    output[`${s.outDir}/index.html`] = renderTemplate(s.layout, V);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    V.page = undefined;
    V.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    V.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    V.tag = undefined;
    const html = renderTemplate('index', V);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    V.page = undefined;
    V.posts = undefined;
    V.pager = undefined;
    V.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = renderTemplate('tag', V);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  V.page = undefined;
  V.posts = undefined;
  V.pager = undefined;
  V.tag = undefined;
  const tagsHtml = renderTemplate('tags', V);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;

  return output;
}
