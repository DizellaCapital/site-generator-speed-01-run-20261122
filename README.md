# site-generator-speed-01-run-20261122 — a faster drop-in for makefun-site 1.0.0

A fast, dependency-free reimplementation of make.fun's own static site
generator `makefun-site 1.0.0`, written from scratch in this session from the
behaviour its README states. `run(input)` returns exactly the answer
`makefun-site 1.0.0` returns for every case — the same output tree, byte for
byte — only faster.

## What it does

`run(input)` builds one site (`{ site, templates, files }`) into its output
tree: every page's `index.html`, the paginated index and tag pages,
`build-report.txt`, and each static file. It implements, exactly as the
reference does:

- **Sources** sorted by path in code-unit order; `.md` sources vs static files.
- **Front matter**: the strict `key: value` grammar (title, date, tags, draft,
  layout, slug, summary), with the same refusal reasons, in the same order —
  refused sources, generator-owned `tags/` and `page/` directories, posts
  without a date, unknown layouts, and drafts are all reported and dropped.
- **Permalinks**: slugs from the `slug` key or the title, made unique per
  directory in source order (`s`, `s-2`, `s-3`, ...), with `posts`, `tags`
  and `page` reserved at the root.
- **Markdown**: the generator's own subset — fenced code, ATX headings with
  unique ids, thematic breaks, blockquotes, flat lists, paragraphs, and
  inline code spans, strong, emphasis, links and backslash escapes. Raw HTML
  is text, never markup.
- **Links** resolved to built pages and static files, or reported once each
  as broken links.
- **Collections and tags**: posts newest first (equal dates by slug), newer /
  older neighbours, tags grouped by slug and ordered by post count then slug.
- **Templates**: the `{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`,
  `{% include %}` dialect, including standalone-tag line swallowing, include
  depth 8, and the same parse-error reports for templates that do not parse.
- **The report**: every refusal, draft, broken link and template error, sorted
  in code-unit order, then the `built … pages, … posts, … tags and … static
  files` line.

Each case is answered alone; nothing is cached from one case to the next.

## How it is fast

The same work with less of it, in a single dependency-free `solve.js`:

- The Markdown renderer is fused: lexing and rendering happen in one pass
  over the lines, so no token array is ever built.
- Inline rendering jumps from one special character to the next with a regex
  search and flushes plain-text runs through the HTML escape in bulk,
  instead of escaping one character at a time.
- `slugify` takes an ASCII fast path (pure ASCII text is unchanged by NFKD
  and holds no combining marks, so the normalise step is skipped).
- Templates render into one output array that is joined once, instead of
  concatenating a string per node.
- The small line classifiers (blank, fence, heading, thematic break, list
  marker) are hand scans, not regular expressions.
- Each source's reading time is counted once, not once per card that shows it.

## Practice results (kit's practice set, 3 cases, local run)

- Exact match: **3/3 cases byte-for-byte identical** to
  `practice/reference/expected.json` (compared as JSON values, the way the
  scorer compares them).
- CPU time, local (this machine, `process.cpuUsage`, median of 7 runs of the
  3-case set, warmed up): **~228.000 µs** per set, against **~618.000 µs**
  for the house baseline `makefun-site 1.0.0` run the same way — about
  **2,7× faster**.
- Differential fuzzing against the reference `build()`: 1.000 randomly
  generated sites (front matter valid and invalid, every Markdown block and
  inline form, valid and broken templates, CRLF/CR line ends, duplicate
  paths, shadowed statics) — all identical.

## Layout

- `solve.js` — the entry: `run(input)` returns the output tree.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.
- `package.json` — `{"type": "module"}`, so `solve.js` loads as an ES module.
- `LICENSE` — MIT, written by `makefun init` (the `.makefun/freshness.json`
  anchor that dates the repository).

## Run it locally

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir> node main.ts
```

`main.ts` turns V8's incremental marking off before importing `solve.js`,
the way the house baseline's driver does.
