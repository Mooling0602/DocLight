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

/**
 * Whether the store is initialized. The test is on *parsed content*, not mere existence: a
 * truncated or malformed `spaces.json` must be treated as missing so startup repairs it from
 * the page files. Testing `existsSync` alone would let a zero-byte index through, and every
 * page would then silently collapse onto the fallback space.
 */
export function storeExists(dataDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(spacesFile(dataDir), 'utf8'));
    return !!parsed && Array.isArray(parsed.spaces);
  } catch {
    return false;
  }
}

/**
 * Whether the index parses but names no spaces. Such an index cannot classify the pages: with no
 * valid slug to fall back to, `readStore` collapses every page onto a synthetic name and the next
 * write persists that loss. It is only *inconsistent* when page files exist — a site the user
 * deliberately emptied also has an empty index and must be left alone, not re-seeded.
 */
export function spacesIndexIsEmpty(dataDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(spacesFile(dataDir), 'utf8'));
    return !!parsed && Array.isArray(parsed.spaces) && parsed.spaces.length === 0;
  } catch {
    return false;
  }
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

/** Options for `writeStore`. */
export interface WriteOptions {
  /**
   * Write only page files that do not exist yet, never overwriting one. Used by the legacy
   * migration and first-run seeding: those create the store, so an existing `<slug>.md` is
   * newer than the source they carry and must win. Without this a legacy `pages.json` that
   * survives its own retirement (a crash between the store write and the move, or a failed
   * rename) would, on a later boot with the index lost, re-import its stale snapshot over the
   * user's live edits.
   */
  onlyCreate?: boolean;
}

/**
 * Persist the database as Markdown files. Writes are content-compared so an update to one page
 * does not rewrite (and re-stamp) every other file, which keeps the store friendly to `git`
 * and file watchers.
 *
 * `removed` lists the slugs the caller itself deleted or renamed. Only those files are
 * unlinked — never "every file the incoming db happens not to mention". That distinction is
 * what keeps a write from destroying data it never saw: a page whose file could not be read
 * is absent from `db`, and a seeding or migration write carries only the pages it was given,
 * so neither may be treated as an authoritative statement that the other files are unwanted.
 */
export function writeStore(
  dataDir: string,
  db: Database,
  removed: Iterable<string> = [],
  options: WriteOptions = {},
): void {
  const dir = pagesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });

  const wanted = new Set<string>();
  for (const page of db.pages) {
    wanted.add(page.slug);
    const file = path.join(dir, `${page.slug}.md`);
    // A file that already exists is the live page, not something the incoming db may replace.
    if (options.onlyCreate && fs.existsSync(file)) continue;
    const next = joinFrontMatter(page);
    if (!sameContent(file, next)) writeAtomic(file, next);
  }

  for (const slug of new Set(removed)) {
    // A slug that is still live wins: a rename that reuses a name must not delete the new file.
    if (wanted.has(slug) || !SLUG_RE.test(slug)) continue;
    try { fs.unlinkSync(path.join(dir, `${slug}.md`)); } catch { /* best effort */ }
  }

  // The index obeys the same rule as the page files: under `onlyCreate` a *valid* existing
  // `spaces.json` is live data — the user may have renamed a space or created one since the
  // snapshot was taken — so the snapshot's list must not replace it. A truncated or malformed
  // index is not live data, so it is still repaired rather than left broken.
  if (!options.onlyCreate || !storeExists(dataDir)) writeSpaces(dataDir, db.spaces);
}

/**
 * Append the spaces in `extra` that `base` does not already name, preserving `base`'s order.
 * A migration carries a snapshot's space list, which cannot know about a space the user created
 * after it was taken; writing that list verbatim would drop the space and send its pages to the
 * fallback on the next read.
 */
export function mergeSpaces(base: Space[], extra: Space[]): Space[] {
  const seen = new Set(base.map((s) => s.slug));
  return [...base, ...extra.filter((s) => !seen.has(s.slug))];
}

/** Write only the spaces index, leaving every page file untouched. */
export function writeSpaces(dataDir: string, spaces: Space[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const next = JSON.stringify({ version: 4, spaces }, null, 2) + '\n';
  if (!sameContent(spacesFile(dataDir), next)) writeAtomic(spacesFile(dataDir), next);
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

/**
 * Rebuild a lost `spaces.json` from the page files already on disk.
 *
 * The spaces index is derived data — each page carries its space in its front matter — so if
 * the index alone is lost (deleted, truncated, half-synced) the content is still intact, and
 * seeding over it would overwrite every page that shares a sample's name. Recovery therefore
 * synthesises one space per distinct slug named by the pages and leaves the files untouched.
 *
 * Returns the reconstructed database, or null when there are no pages to recover from (a
 * genuinely empty directory belongs to the normal first-run seeding path).
 */
export function recoverStore(dataDir: string): Database | null {
  const dir = pagesDir(dataDir);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

  const pages: Page[] = [];
  const slugs = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const slug = entry.name.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    const full = path.join(dir, entry.name);
    let raw = '';
    let stat: fs.Stats | null = null;
    try { raw = fs.readFileSync(full, 'utf8'); stat = fs.statSync(full); } catch { continue; }
    const { meta, body } = splitFrontMatter(raw);
    // Read the space straight from the front matter: readStore would map it onto its fallback
    // when the space list is empty, losing the very grouping this recovery exists to restore.
    // An unusable value (typo/uppercase/empty) is not a name any space could have had, so it
    // falls back rather than being minted into a bogus space the API could never address.
    const named = str(meta.space, '');
    const space = SLUG_RE.test(named) ? named : 'default';
    slugs.add(space);
    const fallbackTime = stat ? Math.round(stat.mtimeMs) : Date.now();
    pages.push({
      slug,
      space,
      parent: typeof meta.parent === 'string' && meta.parent ? meta.parent : null,
      title: str(meta.title, '') || titleFromBody(body, slug),
      content: body.replace(/\n$/, ''),
      createdAt: num(meta.createdAt, fallbackTime),
      updatedAt: num(meta.updatedAt, fallbackTime),
    });
  }
  if (!slugs.size) return null;

  const now = Date.now();
  const spaces: Space[] = [...slugs].sort().map((slug) => {
    const own = pages.filter((p) => p.space === slug);
    // Prefer a top-level page as the space home; without an index the original choice is gone,
    // and dropping a reader onto a nested child would lose the context of its parent.
    const home = own.find((p) => p.parent === null)?.slug ?? own[0]?.slug ?? null;
    return { slug, title: slug, desc: '', home, createdAt: now, updatedAt: now };
  });
  return { version: 4, spaces, pages };
}
