/*
 * File-backed page store.
 *
 * Every page is a real Markdown file so the site can be exported, edited offline and
 * version-controlled as plain text:
 *
 *   <dataDir>/spaces.json          the spaces (site structure metadata)
 *   <dataDir>/pages/<slug>.md      one file per page — YAML front matter + Markdown body
 *
 * The front matter carries the page identity (title / space / parent / timestamps); the body
 * is the Markdown the editor reads and writes. Files a human edited by hand are tolerated:
 * a missing front matter falls back to the filename and file times, unknown keys are ignored.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';

export interface Space {
  slug: string;
  title: string;
  desc: string;
  home: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Page {
  slug: string;
  space: string;
  parent: string | null;
  title: string;
  /** Page body as Markdown. */
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface Database {
  version: 4;
  spaces: Space[];
  pages: Page[];
}

/** Slugs double as file names, so they must be filesystem-safe. Mirrors the server's rule. */
const SLUG_RE = /^[a-z0-9_]{1,80}$/;
const FRONT_MATTER_FENCE = '---';

const spacesFile = (dataDir: string) => path.join(dataDir, 'spaces.json');
const pagesDir = (dataDir: string) => path.join(dataDir, 'pages');

/** A store is considered initialized once its spaces file exists. */
export function storeExists(dataDir: string): boolean {
  return fs.existsSync(spacesFile(dataDir));
}

/* ------------------------------------------------------------ front matter */

interface FrontMatter {
  title?: unknown;
  space?: unknown;
  parent?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Derive a title from the first Markdown heading, for files dropped in without front matter. */
function titleFromBody(body: string, fallback: string): string {
  const heading = body.match(/^\s{0,3}#\s+(.+?)\s*$/m);
  return heading ? heading[1].trim().slice(0, 120) : fallback;
}

/**
 * Split a page file into front matter and body. A file without a leading `---` fence is all
 * body, which makes hand-written notes just work.
 */
function splitFrontMatter(raw: string): { meta: FrontMatter; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith(FRONT_MATTER_FENCE + '\n') && text.trim() !== FRONT_MATTER_FENCE) {
    return { meta: {}, body: text };
  }
  const lines = text.split('\n');
  // lines[0] is the opening fence; find the next bare fence.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONT_MATTER_FENCE) { end = i; break; }
  }
  if (end < 0) return { meta: {}, body: text }; // No closing fence: treat the whole file as body.
  let meta: FrontMatter = {};
  try {
    const parsed = YAML.parse(lines.slice(1, end).join('\n'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as FrontMatter;
  } catch {
    // Malformed YAML must not make the page unreadable; keep the body and use defaults.
    meta = {};
  }
  // Drop the blank line that conventionally separates the fence from the body.
  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '');
  return { meta, body };
}

/** Serialise a page to `---\n<yaml>---\n\n<body>` with a stable key order and no wrapping. */
function joinFrontMatter(page: Page): string {
  const meta = {
    title: page.title,
    space: page.space,
    parent: page.parent,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
  const yaml = YAML.stringify(meta, { lineWidth: 0 }).trimEnd();
  const body = page.content.replace(/\s+$/, '');
  return `${FRONT_MATTER_FENCE}\n${yaml}\n${FRONT_MATTER_FENCE}\n\n${body}\n`;
}

/* ------------------------------------------------------------ read */

/** Read the whole store from disk. Missing pieces degrade to empty rather than throwing. */
export function readStore(dataDir: string): Database {
  let spaces: Space[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(spacesFile(dataDir), 'utf8'));
    if (parsed && Array.isArray(parsed.spaces)) spaces = parsed.spaces;
  } catch { /* empty site */ }

  const pages: Page[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(pagesDir(dataDir), { withFileTypes: true }); } catch { entries = []; }

  const knownSpaces = new Set(spaces.map((s) => s.slug));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const slug = entry.name.slice(0, -3);
    if (!SLUG_RE.test(slug)) {
      console.warn(`· 跳过文件名不合法的页面：${entry.name}（只允许小写字母、数字、下划线）`);
      continue;
    }
    const full = path.join(pagesDir(dataDir), entry.name);
    let raw = '';
    let stat: fs.Stats | null = null;
    try { raw = fs.readFileSync(full, 'utf8'); stat = fs.statSync(full); } catch { continue; }
    const { meta, body } = splitFrontMatter(raw);
    const fallbackTime = stat ? Math.round(stat.mtimeMs) : Date.now();
    pages.push({
      slug,
      space: str(meta.space, spaces[0]?.slug ?? 'default'),
      parent: typeof meta.parent === 'string' && meta.parent ? meta.parent : null,
      title: str(meta.title, '') || titleFromBody(body, slug),
      // The file ends with one trailing newline; drop it so the in-memory body matches what
      // the editor saves (Turndown trims), keeping the content stable across save cycles.
      content: body.replace(/\n$/, ''),
      createdAt: num(meta.createdAt, fallbackTime),
      updatedAt: num(meta.updatedAt, fallbackTime),
    });
  }

  // A page that claims an unknown space (e.g. the space was hand-removed) falls back to the
  // first one, so the sidebar never loses a page entirely.
  const fallback = spaces[0]?.slug ?? 'default';
  for (const p of pages) if (!knownSpaces.has(p.space)) p.space = fallback;

  return { version: 4, spaces, pages };
}

/* ------------------------------------------------------------ write */

function sameContent(file: string, next: string): boolean {
  try { return fs.readFileSync(file, 'utf8') === next; } catch { return false; }
}

function writeAtomic(file: string, data: string): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Persist the database as Markdown files. Writes are content-compared so an update to one page
 * does not rewrite (and re-stamp) every other file, which keeps the store friendly to `git`
 * and file watchers. Files whose page was deleted are removed.
 */
export function writeStore(dataDir: string, db: Database): void {
  const dir = pagesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });

  const wanted = new Set<string>();
  for (const page of db.pages) {
    wanted.add(page.slug);
    const file = path.join(dir, `${page.slug}.md`);
    const next = joinFrontMatter(page);
    if (!sameContent(file, next)) writeAtomic(file, next);
  }

  // Remove orphans (deleted or renamed pages). Only names this store could have produced are
  // eligible: a hand-added file whose name is not a valid slug is skipped on read, so deleting
  // it here would destroy content the user never got to see. Temp files never end in `.md`.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const slug = entry.name.slice(0, -3);
    if (!SLUG_RE.test(slug) || wanted.has(slug)) continue;
    try { fs.unlinkSync(path.join(dir, entry.name)); } catch { /* best effort */ }
  }

  const spaces = JSON.stringify({ version: 4, spaces: db.spaces }, null, 2) + '\n';
  if (!sameContent(spacesFile(dataDir), spaces)) writeAtomic(spacesFile(dataDir), spaces);
}

/* ------------------------------------------------------------ seeding */

/**
 * Load a shipped sample site laid out exactly like the store (`spaces.json` + `pages/*.md`).
 * Returns null when the template is absent or malformed, so the caller can start empty.
 */
export function seedFromTemplate(templateDir: string): Database | null {
  if (!fs.existsSync(spacesFile(templateDir))) return null;
  const db = readStore(templateDir);
  if (!db.spaces.length) return null;
  // Shift every timestamp by one common delta so the sample's designed ordering survives but
  // it does not read as "created months ago" on first run.
  const stamps = [...db.spaces, ...db.pages]
    .map((r) => r.updatedAt)
    .filter((t) => Number.isFinite(t));
  if (stamps.length) {
    const delta = Date.now() - Math.max(...stamps);
    for (const r of [...db.spaces, ...db.pages]) { r.createdAt += delta; r.updatedAt += delta; }
  }
  return db;
}
