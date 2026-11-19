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
import { isDeepStrictEqual } from 'node:util';
import * as YAML from 'yaml';
import { runTemplateTransaction } from './template-transaction.js';
import type { TemplateTransaction } from './template-transaction.js';
import { DEFAULT_SORT, applyManualOrder, isSortKey, removeFromOrder, renameInOrder } from './sort.js';
import type { SortKey } from './sort.js';

export { DEFAULT_SORT, SORT_KEYS, isSortKey } from './sort.js';
export type { SortKey } from './sort.js';

export interface Space {
  slug: string;
  title: string;
  desc: string;
  home: string | null;
  /** Absent means `DEFAULT_SORT`; omitted from `spaces.json` so untouched spaces stay clean. */
  sort?: SortKey;
  /** Page slugs in manual reading order; only consulted while `sort` is `manual`. */
  order?: string[];
  /** Show previous/next page cards at the bottom of every article. False is the default. */
  recommend?: boolean;
  /** Only the locked state is persisted. */
  locked?: boolean;
  /** Source-owned virtual space, never persisted. */
  builtIn?: boolean;
  /** Source-owned pages can be edited in developer mode. */
  devEditable?: boolean;
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
  /** The file begins with an ambiguous, unterminated metadata fence; never edit it in the UI. */
  unclosedFrontMatter?: true;
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
export const BUILT_IN_SLUG = 'doclight-default';
export const isBuiltInPageSlug = (slug: string): boolean => slug.startsWith(`${BUILT_IN_SLUG}-`);
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
 * deliberately emptied also has an empty index and must be left alone.
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
function splitFrontMatter(raw: string): { meta: FrontMatter; body: string; unclosedFrontMatter?: true } {
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
  if (end < 0) return { meta: {}, body: text, unclosedFrontMatter: true }; // Ambiguous: keep readable, but refuse edits.
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
  // The final newline is the file terminator; all whitespace in the body is user content.
  return `${FRONT_MATTER_FENCE}\n${yaml}\n${FRONT_MATTER_FENCE}\n\n${page.content}\n`;
}

type PageMetaKey = 'title' | 'space' | 'parent' | 'createdAt' | 'updatedAt';
const PAGE_META_KEYS: PageMetaKey[] = ['title', 'space', 'parent', 'createdAt', 'updatedAt'];

/** Patch only changed metadata and preserve the original YAML and body when they did not change. */
function updatePageFile(raw: string, page: Page, previous: Page): string {
  const changed = PAGE_META_KEYS.filter(key => page[key] !== previous[key]);
  const bodyChanged = page.content !== previous.content;
  if (!changed.length && !bodyChanged) return raw;

  const opening = /^(\uFEFF?---\r?\n)/.exec(raw);
  if (!opening) {
    // A fence without a terminating newline is an incomplete front matter, not an ordinary note.
    if (raw.replace(/^\uFEFF/, '').trim() === '---') throw sourceError('页面 front matter 缺少结束围栏');
    return joinFrontMatter(page);
  }
  const closing = /^[ \t]*---[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const fence = closing.exec(raw);
  if (!fence) throw sourceError('页面 front matter 缺少结束围栏');
  const yamlText = raw.slice(opening[0].length, fence.index);
  let nextYaml = yamlText;
  if (changed.length) {
    const doc = YAML.parseDocument(yamlText, { uniqueKeys: true });
    if (doc.errors.length || !YAML.isMap(doc.contents) || doc.contents.flow) {
      throw sourceError('页面 front matter 无法安全修改');
    }
    let references = false;
    YAML.visit(doc, (_key, node) => {
      if (YAML.isAlias(node) || (YAML.isNode(node) && 'anchor' in node && node.anchor)) references = true;
    });
    if (references) throw sourceError('页面 front matter 含锚点或别名，无法安全修改');
    const edits: Array<{ start: number; end: number; value: string }> = [];
    const missing: PageMetaKey[] = [];
    for (const key of changed) {
      const node = doc.get(key, true);
      if (node === undefined) { missing.push(key); continue; }
      if (!YAML.isScalar(node) || !node.range || node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
        throw sourceError(`页面 front matter 的 ${key} 无法安全修改`);
      }
      edits.push({ start: node.range[0], end: node.range[1], value: JSON.stringify(page[key]) });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      nextYaml = nextYaml.slice(0, edit.start) + edit.value + nextYaml.slice(edit.end);
    }
    if (missing.length) {
      const eol = opening[0].endsWith('\r\n') ? '\r\n' : '\n';
      if (nextYaml && !nextYaml.endsWith('\n')) nextYaml += eol;
      nextYaml += missing.map(key => `${key}: ${JSON.stringify(page[key])}${eol}`).join('');
    }
    const verified = YAML.parseDocument(nextYaml, { uniqueKeys: true });
    if (verified.errors.length || !YAML.isMap(verified.contents)) throw sourceError('修改后的 front matter 无效');
    const expected = doc.toJS() as Record<string, unknown>;
    for (const key of changed) expected[key] = page[key];
    if (!isDeepStrictEqual(expected, verified.toJS())) throw sourceError('修改 front matter 会改变其他字段，已拒绝');
  }
  const prefix = opening[0] + nextYaml + fence[0];
  if (!bodyChanged) return prefix + raw.slice(fence.index + fence[0].length);
  // Preserve the existing optional blank separator; only the editor-owned body is replaced.
  const oldBody = raw.slice(fence.index + fence[0].length);
  const separator = oldBody.startsWith('\r\n') ? '\r\n' : oldBody.startsWith('\n') ? '\n' : '';
  const eol = opening[0].endsWith('\r\n') ? '\r\n' : '\n';
  // A closing fence at EOF needs a newline before any body can follow it.
  return prefix + (fence[0].endsWith('\n') ? '' : eol) + separator + page.content + '\n';
}

/* ------------------------------------------------------------ ordering */

/** Tie-break on slug so the order is total: equal timestamps must not leave the result to chance. */
function bySlug(a: Page, b: Page): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * Order pages for display. Applied at read time rather than persisted, so the order follows the
 * data (an edit changes `updatedAt`) without having to rewrite every page file.
 */
export function sortPages(pages: Page[], key: SortKey = DEFAULT_SORT): Page[] {
  const sorted = [...pages];
  switch (key) {
    case 'created_desc': sorted.sort((a, b) => b.createdAt - a.createdAt || bySlug(a, b)); break;
    case 'created_asc': sorted.sort((a, b) => a.createdAt - b.createdAt || bySlug(a, b)); break;
    case 'updated_desc': sorted.sort((a, b) => b.updatedAt - a.updatedAt || bySlug(a, b)); break;
    case 'updated_asc': sorted.sort((a, b) => a.updatedAt - b.updatedAt || bySlug(a, b)); break;
    case 'title_asc': sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh') || bySlug(a, b)); break;
    // Manual order is applied by `applyManualOrder` at read time, because it needs the space's
    // stored slug list; leaving the incoming order untouched keeps this helper free of it.
    case 'manual': break;
  }
  return sorted;
}

/* ------------------------------------------------------------ read */

/** Original file contents and identity captured during a store read. */
export interface PageFileSnapshot { raw: string; stat: fs.Stats }

function samePageFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
    && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Read the whole store from disk. Missing pieces degrade to empty rather than throwing. */
export function readStore(dataDir: string, files?: Map<string, PageFileSnapshot>): Database {
  return readStoreSnapshot(dataDir, undefined, files);
}

/** Optionally retain the UTF-8 source text read alongside its decoded page metadata. */
function readStoreSnapshot(dataDir: string, rawFiles?: Map<string, string>, files?: Map<string, PageFileSnapshot>): Database {
  let spaces: Space[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(spacesFile(dataDir), 'utf8'));
    if (parsed && Array.isArray(parsed.spaces)) spaces = parsed.spaces;
  } catch { /* empty site */ }
  // The index is hand-editable, so an unusable `sort` is dropped rather than trusted: an unknown
  // value would match no comparator and silently leave that space unordered.
  for (const space of spaces) {
    if (space.sort !== undefined && !isSortKey(space.sort)) delete space.sort;
    if (space.locked !== true) delete space.locked;
    if (space.recommend !== true) delete space.recommend;
    // The order list is hand-editable too: keep only unique, filesystem-safe slug strings and drop
    // the key entirely when nothing usable is left, so a broken entry cannot reorder pages by accident.
    if (space.order !== undefined) {
      const clean = Array.isArray(space.order)
        ? space.order.filter((slug, index, all) => typeof slug === 'string' && SLUG_RE.test(slug) && all.indexOf(slug) === index)
        : [];
      if (clean.length) space.order = clean;
      else delete space.order;
    }
  }

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
    try {
      if (files) {
        // Bind the text and file identity to the same open file, then confirm the path still names it.
        const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const before = fs.fstatSync(fd);
          raw = fs.readFileSync(fd, 'utf8');
          const after = fs.fstatSync(fd);
          if (!samePageFile(before, after) || !samePageFile(after, fs.lstatSync(full))) continue;
          stat = after;
        } finally { fs.closeSync(fd); }
      } else {
        raw = fs.readFileSync(full, 'utf8');
        stat = fs.statSync(full);
      }
    } catch { continue; }
    rawFiles?.set(slug, raw);
    if (stat) files?.set(slug, { raw, stat });
    const { meta, body, unclosedFrontMatter } = splitFrontMatter(raw);
    const fallbackTime = stat ? Math.round(stat.mtimeMs) : Date.now();
    pages.push({
      slug,
      space: str(meta.space, spaces[0]?.slug ?? 'default'),
      parent: typeof meta.parent === 'string' && meta.parent ? meta.parent : null,
      title: str(meta.title, '') || titleFromBody(body, slug),
      // The file ends with one trailing newline; drop it so the in-memory body matches what
      // the editor saves (Turndown trims), keeping the content stable across save cycles.
      content: body.replace(/\n$/, ''),
      ...(unclosedFrontMatter ? { unclosedFrontMatter } : {}),
      createdAt: num(meta.createdAt, fallbackTime),
      updatedAt: num(meta.updatedAt, fallbackTime),
    });
  }

  // A page that claims an unknown space (e.g. the space was hand-removed) falls back to the
  // first one, so the sidebar never loses a page entirely.
  const fallback = spaces[0]?.slug ?? 'default';
  for (const p of pages) if (!knownSpaces.has(p.space)) p.space = fallback;

  // Order each space's pages by that space's own key. A single flat sort cannot do this: two
  // spaces may choose differently, and the client renders by filtering this array by space, so
  // what has to be right is the relative order within a space. Pages left over (no spaces at all,
  // so every page collapsed onto the synthetic fallback) are appended rather than dropped.
  const ordered: Page[] = [];
  for (const space of spaces) {
    const own = pages.filter((p) => p.space === space.slug);
    ordered.push(...(space.sort === 'manual'
      ? applyManualOrder(own, space.order)
      : sortPages(own, space.sort ?? DEFAULT_SORT)));
  }
  ordered.push(...sortPages(pages.filter((p) => !knownSpaces.has(p.space))));

  return { version: 4, spaces, pages: ordered };
}

/* ------------------------------------------------------------ structure */

/** Directories one developer-mode structural change may touch. */
export interface TemplateDirs {
  templateDir: string;
  dataDir: string;
  stateDir: string;
}

interface SourcePage {
  slug: string;
  raw: string;
  title: string;
  space: string;
  parent: string | null;
}

const SOURCE_FENCE = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---[ \t]*\r?\n)/m;

function sourceError(message: string, code = 409): Error {
  return Object.assign(new Error(message), { code });
}

/** Parse a source page strictly: structural edits must never guess at a broken file. */
function parseSourcePage(slug: string, raw: string): SourcePage {
  const match = SOURCE_FENCE.exec(raw);
  if (!match || match.index !== 0) throw sourceError('内置页面缺少有效的 front matter');
  const doc = YAML.parseDocument(match[2], { uniqueKeys: true });
  if (doc.errors.length || !YAML.isMap(doc.contents)) throw sourceError('内置页面的 front matter 无效');
  const title = doc.get('title');
  const space = doc.get('space');
  const parentNode = doc.get('parent', true);
  if (typeof title !== 'string' || typeof space !== 'string') throw sourceError('内置页面缺少 title 或 space');
  // A YAML `null` scalar reads back as `undefined` from `get`, so inspect the node itself.
  const parent = parentNode === undefined ? null : YAML.isScalar(parentNode) ? parentNode.value : undefined;
  if (!(parent === null || typeof parent === 'string')) throw sourceError('内置页面的 parent 无效');
  return { slug, raw, title, space, parent: parent as string | null };
}

/**
 * Replace only the requested front-matter scalars, leaving comments, ordering, unknown keys and
 * the body byte-for-byte intact. Anchors, aliases and block scalars are refused: rewriting them
 * in place can silently change another key or swallow the following line.
 */
function patchSourceFrontMatter(raw: string, changes: { title?: string; parent?: string | null; space?: string }): string {
  const match = SOURCE_FENCE.exec(raw);
  if (!match || match.index !== 0) throw sourceError('内置页面缺少有效的 front matter');
  const yamlText = match[2];
  const doc = YAML.parseDocument(yamlText, { uniqueKeys: true });
  if (doc.errors.length || !YAML.isMap(doc.contents)) throw sourceError('内置页面的 front matter 无效');
  let hasReferences = false;
  YAML.visit(doc, (_key, node) => {
    if (YAML.isAlias(node) || (YAML.isNode(node) && 'anchor' in node && node.anchor)) hasReferences = true;
  });
  if (hasReferences) throw sourceError('内置页面的 front matter 使用了锚点或别名，无法安全修改');
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const edit = (key: 'title' | 'parent' | 'space', value: unknown) => {
    const node = doc.get(key, true);
    if (!YAML.isScalar(node) || (typeof node.value !== 'string' && node.value !== null) || !node.range ||
        node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
      throw sourceError(`内置页面的 ${key} 无法安全修改`);
    }
    edits.push({ start: node.range[0], end: node.range[1], value: JSON.stringify(value) });
  };
  if (changes.title !== undefined) edit('title', changes.title);
  if (changes.parent !== undefined) edit('parent', changes.parent);
  if (changes.space !== undefined) edit('space', changes.space);
  let nextYaml = yamlText;
  for (const item of edits.sort((a, b) => b.start - a.start)) {
    nextYaml = nextYaml.slice(0, item.start) + item.value + nextYaml.slice(item.end);
  }
  const verified = YAML.parseDocument(nextYaml, { uniqueKeys: true });
  if (verified.errors.length || !YAML.isMap(verified.contents)) throw sourceError('修改后的 front matter 无效');
  const expected = doc.toJS() as Record<string, unknown>;
  if (changes.title !== undefined) expected.title = changes.title;
  if (changes.parent !== undefined) expected.parent = changes.parent;
  if (changes.space !== undefined) expected.space = changes.space;
  if (!isDeepStrictEqual(expected, verified.toJS())) throw sourceError('修改 front matter 会改变其他字段，已拒绝');
  return match[1] + nextYaml + match[3] + raw.slice(match[0].length);
}

interface TemplateIndex {
  spaces: Space[];
  [key: string]: unknown;
}

function readTemplateIndex(tx: TemplateTransaction): TemplateIndex {
  let parsed: unknown;
  try { parsed = JSON.parse(tx.read('template', 'spaces.json').toString('utf8')); }
  catch { throw sourceError('内置空间索引无效'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw sourceError('内置空间索引无效');
  const index = parsed as TemplateIndex;
  if (!Array.isArray(index.spaces)) throw sourceError('内置空间索引无效');
  const defaults = index.spaces.filter(space => space && typeof space === 'object' && space.slug === 'default');
  if (defaults.length !== 1) throw sourceError('内置空间索引无效');
  return index;
}

function writeTemplateIndex(tx: TemplateTransaction, index: TemplateIndex): void {
  tx.write('template', 'spaces.json', JSON.stringify(index, null, 2) + '\n');
}

function readTemplatePages(tx: TemplateTransaction): Map<string, SourcePage> {
  const pages = new Map<string, SourcePage>();
  for (const name of tx.list('template', 'pages')) {
    if (!name.endsWith('.md')) continue;
    const slug = name.slice(0, -3);
    if (!SLUG_RE.test(slug)) throw sourceError(`模板页面文件名不合法：${name}`);
    const page = parseSourcePage(slug, tx.read('template', `pages/${name}`).toString('utf8'));
    if (page.space !== 'default') throw sourceError(`模板页面 ${name} 的 space 不是 default`);
    pages.set(slug, page);
  }
  return pages;
}

function descendantsOfSource(pages: Map<string, SourcePage>, slug: string): Set<string> {
  const doomed = new Set([slug]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const page of pages.values()) {
      if (page.parent && doomed.has(page.parent) && !doomed.has(page.slug)) { doomed.add(page.slug); grew = true; }
    }
  }
  return doomed;
}

/** Rename one built-in page slug, re-pointing its children and the space home in one transaction. */
export function renameTemplatePage(dirs: TemplateDirs, fromSlug: string, toSlug: string): string[] {
  if (!SLUG_RE.test(fromSlug) || !SLUG_RE.test(toSlug)) throw sourceError('slug 只能含小写字母、数字、下划线（1–80 位）', 400);
  if (fromSlug === toSlug) return [];
  return runTemplateTransaction(dirs, tx => {
    const index = readTemplateIndex(tx);
    const pages = readTemplatePages(tx);
    const source = pages.get(fromSlug);
    if (!source) throw sourceError('页面不存在', 404);
    if (pages.has(toSlug) || tx.exists('template', `pages/${toSlug}.md`)) throw sourceError('该 slug 已被占用', 409);
    for (const page of pages.values()) {
      if (page.parent !== fromSlug) continue;
      tx.write('template', `pages/${page.slug}.md`, patchSourceFrontMatter(page.raw, { parent: toSlug }));
    }
    const space = index.spaces.find(item => item.slug === 'default');
    if (space) {
      // The manual order names source file slugs, so the rename has to follow it: leaving the old
      // name behind drops the renamed page out of its stored position (and `readDb` would filter
      // the stale entry away entirely). Both edits share one index write, and an index that
      // mentions neither the home nor the order is left untouched rather than re-serialised.
      const ordered = renameInOrder(space.order, fromSlug, toSlug);
      const orderChanged = ordered !== space.order;
      const homeChanged = space.home === fromSlug;
      if (orderChanged) space.order = ordered;
      if (homeChanged) space.home = toSlug;
      if (orderChanged || homeChanged) writeTemplateIndex(tx, index);
    }
    tx.write('template', `pages/${toSlug}.md`, source.raw);
    tx.remove('template', `pages/${fromSlug}.md`);
    return [fromSlug];
  });
}

/** Remove one built-in page together with its descendants, clearing a home that pointed into it. */
export function deleteTemplateSubtree(dirs: TemplateDirs, slug: string): string[] {
  if (!SLUG_RE.test(slug)) throw sourceError('slug 只能含小写字母、数字、下划线（1–80 位）', 400);
  return runTemplateTransaction(dirs, tx => {
    const index = readTemplateIndex(tx);
    const pages = readTemplatePages(tx);
    if (!pages.has(slug)) throw sourceError('页面不存在', 404);
    const doomed = descendantsOfSource(pages, slug);
    for (const page of pages.values()) {
      if (!doomed.has(page.slug) && page.parent && doomed.has(page.parent)) throw sourceError('仍有页面引用待删除的页面');
    }
    for (const victim of doomed) tx.remove('template', `pages/${victim}.md`);
    const space = index.spaces.find(item => item.slug === 'default');
    if (space) {
      // The order lists source file slugs, so deleted ones have to go with the files. A leftover
      // entry would name a page the space no longer has — the ordinary space API would reject the
      // arrangement if it were re-submitted, and a page later minted under that name would inherit
      // the dead position instead of being appended.
      const ordered = removeFromOrder(space.order, doomed);
      const orderChanged = ordered !== space.order;
      const homeDoomed = !!space.home && doomed.has(space.home);
      if (orderChanged) {
        if (ordered) space.order = ordered;
        else delete space.order;
      }
      if (homeDoomed) space.home = null;
      if (orderChanged || homeDoomed) writeTemplateIndex(tx, index);
    }
    return [...doomed];
  });
}

function dataSpaceSlugs(tx: TemplateTransaction): Set<string> {
  const slugs = new Set<string>();
  try {
    const parsed = JSON.parse(tx.read('data', 'spaces.json').toString('utf8'));
    if (parsed && Array.isArray(parsed.spaces)) {
      for (const space of parsed.spaces as Array<Record<string, unknown>>) {
        if (space && typeof space.slug === 'string') slugs.add(space.slug);
      }
    }
  } catch { /* an absent or broken ordinary index is handled by the ordinary store itself */ }
  return slugs;
}

/** Slugs of every ordinary page file, used to refuse a move that would overwrite one. */
function dataPageSlugs(tx: TemplateTransaction): Set<string> {
  const slugs = new Set<string>();
  for (const name of tx.list('data', 'pages')) {
    if (!name.endsWith('.md')) continue;
    const slug = name.slice(0, -3);
    if (SLUG_RE.test(slug)) slugs.add(slug);
  }
  return slugs;
}

interface OrdinaryPage {
  slug: string;
  raw: string;
  space: string;
  parent: string | null;
}

function readOrdinaryPages(tx: TemplateTransaction): Map<string, OrdinaryPage> {
  const pages = new Map<string, OrdinaryPage>();
  for (const slug of dataPageSlugs(tx)) {
    const raw = tx.read('data', `pages/${slug}.md`).toString('utf8');
    const { meta } = splitFrontMatter(raw);
    if (typeof meta.space !== 'string') throw sourceError(`普通页面 ${slug}.md 的 front matter 无效`);
    const parent = meta.parent === undefined || meta.parent === null ? null : meta.parent;
    if (!(parent === null || typeof parent === 'string')) throw sourceError(`普通页面 ${slug}.md 的 parent 无效`);
    pages.set(slug, { slug, raw, space: meta.space, parent });
  }
  return pages;
}

function ordinaryDescendants(pages: Map<string, OrdinaryPage>, slug: string): Set<string> {
  const doomed = new Set([slug]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const page of pages.values()) {
      if (page.parent && doomed.has(page.parent) && !doomed.has(page.slug)) { doomed.add(page.slug); grew = true; }
    }
  }
  return doomed;
}

/**
 * Move a built-in page subtree into an ordinary space: every source file becomes a normal page
 * file in one transaction. Markdown bodies and unknown front matter are preserved verbatim.
 */
export function moveTemplatePageToSpace(dirs: TemplateDirs, sourceSlug: string, targetSpace: string, targetParent: string | null = null): string[] {
  if (!SLUG_RE.test(sourceSlug)) throw sourceError('页面不存在', 404);
  if (!SLUG_RE.test(targetSpace)) throw sourceError('目标空间不存在', 404);
  if (targetParent !== null && !SLUG_RE.test(targetParent)) throw sourceError('目标父级不存在', 404);
  return runTemplateTransaction(dirs, tx => {
    const index = readTemplateIndex(tx);
    const pages = readTemplatePages(tx);
    if (!pages.has(sourceSlug)) throw sourceError('页面不存在', 404);
    const doomed = descendantsOfSource(pages, sourceSlug);
    const taken = dataPageSlugs(tx);
    const ordinarySpaces = dataSpaceSlugs(tx);
    for (const slug of doomed) {
      if (taken.has(slug)) throw sourceError(`普通空间中已有页面 ${slug}，无法移动`, 409);
      if (ordinarySpaces.has(slug)) throw sourceError(`普通空间中已有与 ${slug} 同名的空间，无法移动`, 409);
    }
    const ordinary = readOrdinaryPages(tx);
    if (targetParent !== null) {
      const target = ordinary.get(targetParent);
      if (!target) throw sourceError('目标父级不存在', 404);
      if (target.space !== targetSpace) throw sourceError('父级必须位于目标空间');
      if (doomed.has(targetParent)) throw sourceError('不能移动到自己的子页面之下');
    }
    const emptied = new Set<string>();
    for (const slug of doomed) {
      const page = pages.get(slug)!;
      const parent = slug === sourceSlug
        ? targetParent
        : page.parent && doomed.has(page.parent) ? page.parent : null;
      const next = patchSourceFrontMatter(page.raw, { space: targetSpace, parent });
      tx.write('data', `pages/${slug}.md`, next);
      tx.remove('template', `pages/${slug}.md`);
      emptied.add(slug);
    }
    const space = index.spaces.find(item => item.slug === 'default');
    if (space) {
      // Moved-away pages leave the built-in space, so their entries leave its order too.
      const ordered = removeFromOrder(space.order, emptied);
      const orderChanged = ordered !== space.order;
      const homeDoomed = !!space.home && doomed.has(space.home);
      if (orderChanged) {
        if (ordered) space.order = ordered;
        else delete space.order;
      }
      if (homeDoomed) space.home = null;
      if (orderChanged || homeDoomed) writeTemplateIndex(tx, index);
    }
    return [...emptied];
  });
}

/**
 * Move an ordinary page subtree into the built-in space: the files become source pages and the
 * ordinary index loses any home pointer into the moved subtree.
 */
export function moveDataPageToTemplate(dirs: TemplateDirs, dataSlug: string): string[] {
  if (!SLUG_RE.test(dataSlug)) throw sourceError('页面不存在', 404);
  return runTemplateTransaction(dirs, tx => {
    const templatePages = readTemplatePages(tx);
    const ordinary = readOrdinaryPages(tx);
    const source = ordinary.get(dataSlug);
    if (!source) throw sourceError('页面不存在', 404);
    const doomed = ordinaryDescendants(ordinary, dataSlug);
    const ordinarySpaces = dataSpaceSlugs(tx);
    for (const slug of doomed) {
      if (templatePages.has(slug) || tx.exists('template', `pages/${slug}.md`)) {
        throw sourceError(`内置空间中已有页面 ${slug}，无法移动`, 409);
      }
      // The page becomes `doclight-default-<slug>` on the public side, which must stay unique.
      const virtual = `${BUILT_IN_SLUG}-${slug}`;
      if (ordinary.has(virtual) || ordinarySpaces.has(virtual)) {
        throw sourceError(`普通空间中已有与内置页面 ${virtual} 同名的条目，无法移动`, 409);
      }
    }
    let dataIndex: { spaces?: unknown } | null = null;
    try { dataIndex = JSON.parse(tx.read('data', 'spaces.json').toString('utf8')); } catch { dataIndex = null; }
    for (const slug of doomed) {
      const page = ordinary.get(slug)!;
      // The root leaves its old space; children keep the subtree shape.
      const parent = page.parent && doomed.has(page.parent) ? page.parent : null;
      tx.write('template', `pages/${slug}.md`, patchSourceFrontMatter(page.raw, { space: 'default', parent }));
      tx.remove('data', `pages/${slug}.md`);
    }
    if (dataIndex && Array.isArray(dataIndex.spaces)) {
      let changed = false;
      for (const space of dataIndex.spaces as Array<Record<string, unknown>>) {
        if (typeof space.home === 'string' && doomed.has(space.home)) { space.home = null; changed = true; }
        // The moved pages are no longer part of the ordinary space, so their manual positions have
        // to go with them — a stale entry would be rejected on the next re-submit and could later
        // be inherited by an unrelated page minted under the same slug.
        if (Array.isArray(space.order)) {
          const kept = removeFromOrder(space.order as string[], doomed);
          if (kept !== space.order) {
            if (kept) space.order = kept;
            else delete space.order;
            changed = true;
          }
        }
      }
      if (changed) tx.write('data', 'spaces.json', JSON.stringify(dataIndex, null, 2) + '\n');
    }
    return [...doomed];
  });
}

/**
 * Delete the source-backed built-in space: every template page goes away and the index keeps a
 * tombstone so the space is not recreated (or reported as corrupt) on the next start.
 */
export function deleteTemplateSpace(dirs: TemplateDirs): string[] {
  return runTemplateTransaction(dirs, tx => {
    const index = readTemplateIndex(tx);
    const pages = readTemplatePages(tx);
    for (const slug of pages.keys()) tx.remove('template', `pages/${slug}.md`);
    index.doclightBuiltInDeleted = true;
    writeTemplateIndex(tx, index);
    return [...pages.keys()];
  });
}

/* ------------------------------------------------------------ write */

/** Edit exactly one existing source file without normalising its other YAML metadata. */
export function editTemplatePage(templateDir: string, slug: string, changes: { title?: string; content?: string; parent?: string | null }): void {
  const invalid = () => Object.assign(new Error('内置页面模板无效或不安全'), { code: 400 });
  if (!SLUG_RE.test(slug)) throw invalid();
  const dir = path.join(templateDir, 'pages');
  const file = path.join(dir, `${slug}.md`);
  let stat: fs.Stats;
  let raw: string;
  try {
    if (!fs.lstatSync(templateDir).isDirectory() || !fs.lstatSync(dir).isDirectory()) throw invalid();
    stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw invalid();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw invalid();
      raw = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  } catch { throw invalid(); }
  // The single-file editor reports every malformed source as 400; structural helpers below use
  // 409 for conflicts, so normalise this path to the documented status.
  let patched = raw;
  try {
    if (parseSourcePage(slug, raw).space !== 'default') throw invalid();
    if (changes.title !== undefined || changes.parent !== undefined) {
      patched = patchSourceFrontMatter(raw, { title: changes.title, parent: changes.parent });
    }
  } catch { throw invalid(); }
  let next = patched;
  if (changes.content !== undefined) {
    const before = SOURCE_FENCE.exec(raw);
    const after = SOURCE_FENCE.exec(patched);
    if (!before || !after) throw invalid();
    const oldBody = raw.slice(before[0].length);
    const separator = oldBody.startsWith('\r\n') ? '\r\n' : oldBody.startsWith('\n') ? '\n' : '';
    next = patched.slice(0, after[0].length) + separator + changes.content + '\n';
  }
  if (next === raw) return;
  const tmp = path.join(dir, `.${slug}.${process.pid}.${require('node:crypto').randomBytes(12).toString('hex')}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(tmp, 'wx', stat.mode & 0o777);
    created = true;
    try { fs.writeFileSync(fd, next, 'utf8'); } finally { fs.closeSync(fd); }
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1 ||
        current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) {
      throw Object.assign(new Error('模板文件已变化，请重新加载后重试'), { code: 409 });
    }
    fs.renameSync(tmp, file);
    created = false;
  } finally {
    if (created) fs.unlinkSync(tmp);
  }
}

/** Create one source page exclusively; never replace an existing file or symlink. */
export function createTemplatePage(templateDir: string, page: Page): void {
  const invalid = () => Object.assign(new Error('内置页面模板无效或不安全'), { code: 400 });
  if (!SLUG_RE.test(page.slug) || page.space !== 'default') throw invalid();
  const dir = path.join(templateDir, 'pages');
  if (!fs.lstatSync(templateDir).isDirectory() || !fs.lstatSync(dir).isDirectory()) throw invalid();
  const file = path.join(dir, `${page.slug}.md`);
  const tmp = path.join(dir, `.new.${process.pid}.${require('node:crypto').randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o644);
  try {
    try { fs.writeFileSync(fd, joinFrontMatter(page), 'utf8'); } finally { fs.closeSync(fd); }
    fs.linkSync(tmp, file);
  } finally { fs.unlinkSync(tmp); }
}

/** Update source-space metadata without serialising pages or discarding unknown index fields. */
export function editTemplateSpace(templateDir: string, changes: { title?: string; desc?: string; sort?: SortKey | null; order?: string[] | null; recommend?: boolean | null; virtualSlug?: string }): void {
  const invalid = () => Object.assign(new Error('内置空间模板无效或不安全'), { code: 400 });
  const file = path.join(templateDir, 'spaces.json');
  let stat: fs.Stats;
  let raw: string;
  try {
    if (!fs.lstatSync(templateDir).isDirectory()) throw invalid();
    stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw invalid();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw invalid();
      raw = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  } catch { throw invalid(); }
  let index: { spaces?: unknown; doclightVirtualSlug?: unknown };
  try { index = JSON.parse(raw); } catch { throw invalid(); }
  if (!index || !Array.isArray(index.spaces)) throw invalid();
  const validVirtualSlug = (value: unknown) => value === BUILT_IN_SLUG || (typeof value === 'string' && SLUG_RE.test(value) && value !== 'spaces' && value !== 'api');
  if (index.doclightVirtualSlug !== undefined && !validVirtualSlug(index.doclightVirtualSlug)) throw invalid();
  if (changes.virtualSlug !== undefined) {
    if (!validVirtualSlug(changes.virtualSlug)) throw invalid();
    index.doclightVirtualSlug = changes.virtualSlug;
  }
  const matches = index.spaces.filter((s: unknown) => s && typeof s === 'object' && (s as Space).slug === 'default');
  if (matches.length !== 1) throw invalid();
  const space = matches[0] as Space;
  if (changes.title !== undefined) space.title = changes.title;
  if (changes.desc !== undefined) space.desc = changes.desc;
  if (changes.sort !== undefined) {
    if (changes.sort === null) delete space.sort;
    else space.sort = changes.sort;
  }
  if (changes.recommend !== undefined) {
    if (changes.recommend === null) delete space.recommend;
    else space.recommend = changes.recommend;
  }
  if (changes.order !== undefined) {
    if (changes.order === null) delete space.order;
    else space.order = changes.order;
  }
  space.updatedAt = Date.now();
  const next = JSON.stringify(index, null, 2) + '\n';
  const tmp = path.join(templateDir, `.spaces.${process.pid}.${require('node:crypto').randomBytes(12).toString('hex')}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(tmp, 'wx', stat.mode & 0o777);
    created = true;
    try { fs.writeFileSync(fd, next, 'utf8'); } finally { fs.closeSync(fd); }
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1 ||
        current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) {
      throw Object.assign(new Error('模板文件已变化，请重新加载后重试'), { code: 409 });
    }
    fs.renameSync(tmp, file);
    created = false;
  } finally { if (created) fs.unlinkSync(tmp); }
}

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
   * Write only page files that do not exist yet, never overwriting one. Used by legacy migration
   * and empty-store initialization; during migration an existing `<slug>.md` is newer than
   * the snapshot and must win. Without this a legacy `pages.json` that
   * survives its own retirement (a crash between the store write and the move, or a failed
   * rename) would, on a later boot with the index lost, re-import its stale snapshot over the
   * user's live edits.
   */
  onlyCreate?: boolean;
  /** Leave existing pages in locked spaces byte-for-byte unchanged during ordinary writes. */
  preserveLocked?: boolean;
  /** Explicit source and destination for a page slug rename, preserving its original metadata. */
  rename?: { from: string; to: string };
  /** Original files captured by readStore when the caller decided which pages to remove.
   * Existing files cannot be removed without this snapshot. */
  expectedRemoved?: ReadonlyMap<string, PageFileSnapshot>;
}

/**
 * Persist the database as Markdown files. Writes are content-compared so an update to one page
 * does not rewrite (and re-stamp) every other file, which keeps the store friendly to `git`
 * and file watchers.
 *
 * `removed` lists the slugs the caller itself deleted or renamed. Only those files are
 * unlinked — never "every file the incoming db happens not to mention". Existing removed files
 * require the original `readStore` snapshot in `options.expectedRemoved`. That distinction is
 * what keeps a write from destroying data it never saw: a page whose file could not be read
 * is absent from `db`, and a migration write carries only the pages in its snapshot,
 * so neither may be treated as an authoritative statement that the other files are unwanted.
 */
export function writeStore(
  dataDir: string,
  db: Database,
  removed: Iterable<string> = [],
  options: WriteOptions = {},
): void {
  const dir = pagesDir(dataDir);
  const removedSlugs = [...new Set(removed)];
  if (options.onlyCreate && removedSlugs.length) throw sourceError('仅创建模式不能删除页面');
  fs.mkdirSync(dir, { recursive: true });

  const wanted = new Set<string>();
  // Compare against the same source text and stat-derived defaults used to build the snapshot.
  const rawFiles = new Map<string, string>();
  const existing = new Map(readStoreSnapshot(dataDir, rawFiles).pages.map(page => [page.slug, page]));
  if (options.rename) {
    const { from, to } = options.rename;
    if (options.onlyCreate || !SLUG_RE.test(from) || !SLUG_RE.test(to) || from === to
        || db.pages.some(page => page.slug === from) || !db.pages.some(page => page.slug === to)) {
      throw sourceError('无法安全重命名页面文件');
    }
    if (!existing.has(from)) throw sourceError('页面源文件不存在或无法读取，已拒绝重命名');
    if (fs.existsSync(path.join(dir, `${to}.md`))) throw sourceError('页面目标文件已存在，已拒绝覆盖');
  }
  const pending: Array<{ file: string; next: string; sourceFile?: string; sourceRaw?: string; newFile: boolean }> = [];
  const lockedSpaces = new Set(options.preserveLocked ? db.spaces.filter(s => s.locked === true).map(s => s.slug) : []);
  for (const page of db.pages) {
    // The slug becomes a file name, so it is validated here rather than trusted from the caller.
    // `readStore` filters such files on the way in, but a write is the only place that can put one
    // on disk at all — and a slug like `../../x` would escape `pages/` entirely, writing the page
    // where no later read can find it. The legacy migration is the path that carries slugs the
    // programme did not mint itself, but validating at the single write chokepoint covers every
    // caller, including any added later.
    if (!SLUG_RE.test(page.slug)) {
      console.warn(`· 跳过文件名不合法的页面：${page.slug}（只允许小写字母、数字、下划线）`);
      continue;
    }
    wanted.add(page.slug);
    const file = path.join(dir, `${page.slug}.md`);
    // A file that already exists is the live page, not something the incoming db may replace.
    if (options.onlyCreate && fs.existsSync(file)) continue;
    // Serializing the entire tree can normalize unrelated files; a locked page must stay untouched.
    if (lockedSpaces.has(page.space) && fs.existsSync(file)) continue;
    let next: string;
    const sourceSlug = options.rename?.to === page.slug ? options.rename.from : page.slug;
    const sourceFile = path.join(dir, `${sourceSlug}.md`);
    const raw = rawFiles.get(sourceSlug);
    if (fs.existsSync(sourceFile)) {
      const previous = existing.get(sourceSlug);
      if (!previous || raw === undefined) throw sourceError(`无法读取页面 ${sourceSlug}.md，已拒绝覆盖`);
      next = updatePageFile(raw, page, previous);
    } else if (sourceSlug !== page.slug) {
      throw sourceError('页面源文件不存在，已拒绝重命名');
    } else if (raw !== undefined) {
      throw sourceError('页面源文件已变化，已拒绝覆盖');
    } else {
      next = joinFrontMatter(page);
    }
    // Existing pages have already been read for the snapshot; avoid reading unchanged pages again.
    const newFile = sourceSlug !== page.slug || raw === undefined;
    if (newFile || next !== raw) {
      pending.push({ file, next, ...(raw === undefined ? {} : { sourceFile, sourceRaw: raw }), newFile });
    }
  }

  // A write-time snapshot cannot establish what the caller originally chose to delete.
  const expectedRemoved = options.expectedRemoved;
  const removals: Array<{ file: string; expected: PageFileSnapshot }> = [];
  for (const slug of removedSlugs) {
    // A slug that is still live wins: a rename that reuses a name must not delete the new file.
    if (wanted.has(slug) || !SLUG_RE.test(slug)) continue;
    const file = path.join(dir, `${slug}.md`);
    const expected = expectedRemoved?.get(slug);
    if (!expected) {
      try { fs.lstatSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw sourceError('待删除页面无法读取，已拒绝删除');
      }
      throw sourceError('待删除页面不在原始快照中，已拒绝删除');
    }
    removals.push({ file, expected });
  }

  const verifyRemoval = ({ file, expected }: { file: string; expected: PageFileSnapshot }, partial: boolean) => {
    try {
      const before = fs.lstatSync(file);
      if (!samePageFile(expected.stat, before)) throw new Error('file changed');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let raw: string;
      try {
        const opened = fs.fstatSync(fd);
        if (!samePageFile(before, opened)) throw new Error('file changed');
        raw = fs.readFileSync(fd, 'utf8');
        if (!samePageFile(opened, fs.fstatSync(fd))) throw new Error('file changed');
      } finally { fs.closeSync(fd); }
      const after = fs.lstatSync(file);
      if (samePageFile(before, after) && raw === expected.raw) return;
    } catch { /* A missing or unreadable file is also a conflict. */ }
    throw sourceError(partial
      ? '待删除页面已变化或无法读取，原文件未删除；部分更改可能已写入，请检查后重试'
      : '待删除页面已变化或无法读取，已拒绝删除');
  };
  // Validate every removal before writing anything. Check again immediately before each unlink.
  for (const removal of removals) verifyRemoval(removal, false);

  // Recheck only pages that will change, so external edits during preparation are not silently
  // overwritten. This is not a cross-process transaction; a later race remains possible.
  for (const { file, sourceFile, sourceRaw, newFile } of pending) {
    if (newFile && fs.existsSync(file)) throw sourceError('页面目标文件已存在，已拒绝覆盖');
    if (sourceFile) {
      let current: string;
      try { current = fs.readFileSync(sourceFile, 'utf8'); }
      catch { throw sourceError('页面源文件无法读取，已拒绝覆盖'); }
      if (current !== sourceRaw) throw sourceError('页面文件已变化，请重新加载后重试');
    }
  }
  // Validate every page before writing any of them or deleting a renamed page.
  for (const { file, next } of pending) writeAtomic(file, next);

  // Path verification and unlink are separate operations; non-cooperating external writers can
  // still race in between. This is not a cross-process transaction or an atomic conditional unlink.
  let removedCount = 0;
  for (const removal of removals) {
    const partial = pending.length > 0 || removedCount > 0;
    verifyRemoval(removal, partial);
    try { fs.unlinkSync(removal.file); }
    catch { throw sourceError(partial
      ? '无法删除页面；部分更改可能已写入，请检查后重试'
      : '无法删除页面，请检查文件状态后重试'); }
    removedCount++;
  }

  // The index obeys the same rule as the page files: under `onlyCreate` a *usable* existing
  // `spaces.json` is live data — the user may have renamed a space or created one since the
  // snapshot was taken — so the snapshot's list must not replace it. An index that is missing,
  // truncated or names no spaces is not live data (it cannot classify a single page), so it is
  // still repaired rather than left broken.
  if (!options.onlyCreate || !storeExists(dataDir) || spacesIndexIsEmpty(dataDir)) {
    writeSpaces(dataDir, db.spaces);
  }
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
  const normalized = spaces.map(({ locked, ...space }) => locked === true ? { ...space, locked: true } : space);
  const next = JSON.stringify({ version: 4, spaces: normalized }, null, 2) + '\n';
  if (!sameContent(spacesFile(dataDir), next)) writeAtomic(spacesFile(dataDir), next);
}

/* ------------------------------------------------------------ recovery */

/**
 * Rebuild a lost `spaces.json` from the page files already on disk.
 *
 * The spaces index is derived data — each page carries its space in its front matter — so if
 * the index alone is lost (deleted, truncated, half-synced) the content is still intact.
 * Recovery synthesises one space per distinct slug named by the pages and leaves the files untouched.
 *
 * Returns the reconstructed database, or null when there are no pages to recover from; a fresh
 * installation starts with an empty user store and serves the built-in space separately.
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
