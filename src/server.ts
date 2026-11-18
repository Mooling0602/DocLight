#!/usr/bin/env node
/**
 * DocLight - lightweight TypeScript documentation site
 *
 *   npm start                 # auto-detect a free port and start
 *   PORT=8080 npm start       # start from the given port
 *
 * Configuration (see src/config.ts): built-in defaults < doclight.toml < environment.
 * The file is <root>/doclight.toml unless DOCLIGHT_CONFIG points elsewhere. On first run
 * a fully commented template is written there so the options are discoverable in place —
 * it holds no active values, so the resolved configuration is unchanged; a malformed file
 * still aborts startup.
 *
 * Environment (temporary overrides; an existing variable always wins, empty clears):
 *   PORT                 starting TCP port (default 4173)
 *   DOCLIGHT_HOST        bind address (default: all interfaces)
 *   DOCLIGHT_DATA_DIR    writable data directory (default: <root>/data)
 *   DOCLIGHT_STRICT_PORT fail instead of scanning for the next free port
 *   DOCLIGHT_CONFIG      path to the TOML configuration file
 *
 * Pages are stored as Markdown files (`<dataDir>/pages/<slug>.md`, YAML front matter) with the
 * spaces in `<dataDir>/spaces.json`; see src/store.ts. A legacy single `pages.json` (v3 HTML or
 * v4 Markdown) is split into that layout on first start.
 *
 * API:
 *   GET    /api/pages        page list (without content)
 *   GET    /api/pages/:slug  single page detail (Markdown content)
 *   POST   /api/pages        create { title }
 *   PUT    /api/pages/:slug  update { title?, content?, slug?, space?, parent? }
 *   DELETE /api/pages/:slug  delete
 *   POST   /api/spaces       create { title, desc? }
 *   PUT    /api/spaces/:slug update { title?, desc?, sort?, order?, recommend?, slug? }
 *   DELETE /api/spaces/:slug delete
 *
 * Filing footer (see src/beian.ts), all optional:
 *   DOCLIGHT_ICP           ICP filing number, e.g. 浙ICP备12345678号-1
 *   DOCLIGHT_ICP_URL       override the filing portal link
 *   DOCLIGHT_POLICE        public security filing number, e.g. 京公网安备11010502030123号
 *   DOCLIGHT_POLICE_URL    override the public security portal link
 *   DOCLIGHT_COPYRIGHT     copyright line, e.g. © 2026 Mooling
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { injectFooter, readFooterOptions } from './beian.js';
import { loadConfig, ensureConfigFile } from './config.js';
import { htmlToMarkdown, sanitizeMarkdown } from './markdown.js';
import { readStore, writeStore, writeSpaces, mergeSpaces, storeExists, spacesIndexIsEmpty, recoverStore, isSortKey, SORT_KEYS, BUILT_IN_SLUG, isBuiltInPageSlug, editTemplatePage, editTemplateSpace, createTemplatePage, renameTemplatePage, deleteTemplateSubtree, deleteTemplateSpace, moveTemplatePageToSpace, moveDataPageToTemplate } from './store.js';
import { removeFromOrder, renameInOrder } from './sort.js';
import { recoverTemplateTransaction } from './template-transaction.js';
import type { AppConfig } from './config.js';
import type { Database, Page, Space, WriteOptions, SortKey, TemplateDirs } from './store.js';

interface AuthRecord {
  user: string | null;
  salt: string;
  iters: number;
  stored: string | null;
}

interface Session {
  user: string;
  exp: number;
}

type RequestBody = Record<string, unknown>;

// The compiled entry point lives in dist/, while public/ and data/ stay at the project root.
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// Configuration is resolved once, before anything depends on it: the TOML file (if any)
// plus environment overrides. A malformed file must abort startup rather than fall back
// silently, because that would hide the operator's mistake behind working defaults.
//
// The starter file is seeded first so a first run leaves an editable doclight.toml in
// place, making the options discoverable without a trip to the README. It is written
// only when the operator has no file at the default path, and never holds active values
// (every key is commented out), so it cannot change the resolved configuration.
const CONFIG: AppConfig = (() => {
  const seeded = ensureConfigFile({ root: ROOT });
  if (seeded) console.log(`· 已生成配置文件模板 → ${seeded}（默认全注释，按需取消注释）`);
  try {
    return loadConfig({ root: ROOT });
  } catch (err) {
    console.error('配置错误:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
// The Nix package ships in a read-only store path, so everything writable must be
// relocatable. `dataDir` defaults to the project layout and can be redirected to a
// persistent volume through the config file or DOCLIGHT_DATA_DIR.
const DATA_DIR = CONFIG.dataDir;
// Pages are stored as real Markdown files (`data/pages/<slug>.md`, YAML front matter) and the
// spaces as `data/spaces.json`; see src/store.ts. A single legacy `data/pages.json` (v3 or v4)
// is split into that layout on first start.
const LEGACY_DATA_FILE = path.join(DATA_DIR, 'pages.json');
// Proof that this data directory has already been migrated to the file layout. Deliberately not a
// dotfile: sync tools commonly exclude those by default, and losing this marker is exactly what
// would let a stale snapshot be re-migrated. See `legacyFileIsResidue`.
const MIGRATION_MARKER = path.join(DATA_DIR, 'pages.json.migrated');
const TEMPLATE_DIR = path.join(ROOT, 'template');
// Developer-mode structural edits are journaled in one private directory. Every DocLight process
// that may edit the same template must use this exact directory; see src/template-transaction.ts.
const TEMPLATE_STATE_DIR = path.join(ROOT, '.doclight');
function templateDirs(): TemplateDirs {
  fs.mkdirSync(TEMPLATE_STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(TEMPLATE_STATE_DIR, 0o700);
  return { templateDir: TEMPLATE_DIR, dataDir: DATA_DIR, stateDir: TEMPLATE_STATE_DIR };
}
function templateErrorStatus(error: unknown): number {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && code >= 400 && code < 600 ? code : 500;
}
const BODY_LIMIT = 1024 * 1024; // 1MB
// Displayed in the shell's sidebar footer. Read once: the running build cannot change version.
const PACKAGE_VERSION = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' && /^\d+\.\d+\.\d+/.test(parsed.version) ? parsed.version : '';
  } catch { return ''; }
})();

/* ---------------------------------------------------------------- Data layer */

/** New installations start with no user-owned content; the built-in space is a separate view. */
function emptyDb(): Database {
  return { version: 4, spaces: [], pages: [] };
}

/**
 * Bring the data directory up to the Markdown-file layout on startup:
 *   1. a legacy `pages.json` is split into `spaces.json` + `pages/*.md` (HTML bodies converted);
 *   2. otherwise, a fresh empty user store is created.
 */
function ensureData(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // An index that parses but names no spaces cannot classify the pages: readStore would collapse
  // every one of them onto a synthetic fallback and the next write would persist that loss. When
  // pages exist the index is therefore rebuilt from them, exactly as for a missing index. A site
  // the user deliberately emptied has no pages, so it is left alone rather than re-seeded.
  if (spacesIndexIsEmpty(DATA_DIR)) {
    const repaired = recoverStore(DATA_DIR);
    if (repaired) {
      console.warn(`· ${path.join(DATA_DIR, 'spaces.json')} 不含任何空间，已按现有页面重建索引（页面文件未改动）`);
      writeSpaces(DATA_DIR, repaired.spaces);
      // A rebuilt index makes the store authoritative again, so any lingering legacy file is
      // retired here too — otherwise a later lost index would fall through to the legacy branch.
      retireLegacyFile();
      return;
    }
    // No pages to rebuild from. An empty index is consistent with a site the user emptied on
    // purpose, but if a legacy file is also present *it* is this site's real data — the index was
    // written empty and the pages never made it out of the single file. Retiring it here (which the
    // `storeExists` branch below would do, an empty-but-parseable index counting as a store) would
    // move the user's only copy aside unread and leave them looking at an empty site. A file already
    // superseded by an earlier migration is residue, not data, so it is left to below.
    if (fs.existsSync(LEGACY_DATA_FILE) && !legacyFileIsResidue()) {
      migrateLegacyFile();
      return;
    }
  }

  if (storeExists(DATA_DIR)) {
    // The store is authoritative. A legacy file left behind by an older version must be moved
    // out of the way: if `spaces.json` is ever lost, that stale snapshot would otherwise win the
    // legacy branch below and silently re-import pre-edit content over the live page files.
    retireLegacyFile();
    return;
  }

  // A legacy file already superseded by an earlier migration is a stale re-appearance — the retire
  // step failed, or the file was copied back in. Migrating it would re-import pre-edit content over
  // the live page files, and with `onlyCreate` it would still resurrect every page the user has
  // since *deleted* (a missing file looks like one the snapshot should supply). It is therefore
  // retired instead (its bytes preserved) and the store is rebuilt from those files below.
  if (fs.existsSync(LEGACY_DATA_FILE) && legacyFileIsResidue()) {
    console.warn(`· ${path.basename(LEGACY_DATA_FILE)} 已被此前的迁移取代，判定为残留，将按页面文件恢复`);
    retireLegacyFile();
  } else if (fs.existsSync(LEGACY_DATA_FILE)) {
    // A legacy single file is the site's real data, so it is migrated first. Hand-written pages
    // already sitting in `pages/` survive this because a write only unlinks files the caller
    // declared removed, never every file the incoming db happens not to mention.
    migrateLegacyFile();
    return;
  }

  // With no legacy file, pages on disk mean the spaces index alone was lost. It is derived data
  // (every page carries its space in its front matter), so it is rebuilt from the pages.
  // Only the index is written: the page files are the source of truth and are left as they are.
  const recovered = recoverStore(DATA_DIR);
  if (recovered) {
    console.warn(`· 未找到 ${path.join(DATA_DIR, 'spaces.json')}，已按现有页面重建索引（页面文件未改动）`);
    writeSpaces(DATA_DIR, recovered.spaces);
    return;
  }

  // The template is served virtually, not copied into a duplicate writable space.
  writeDb(emptyDb(), [], { onlyCreate: true });
  console.log(`· 已初始化空用户数据目录 → ${DATA_DIR}`);
}

/**
 * Move a migrated-away `pages.json` aside so it can never shadow the store again, keeping its
 * bytes as `pages.json.bak` for recovery. When a backup already exists the legacy file is only
 * removed if it is byte-identical — the crash-between-migration-and-this-step case. A differing
 * file is not a duplicate (it can be a snapshot copied in from another machine), so its bytes are
 * kept under a free `.bak.N` name rather than discarded.
 */
function retireLegacyFile(): void {
  if (!fs.existsSync(LEGACY_DATA_FILE)) return;
  // Written before the move, so a crash between the two still leaves proof the migration happened.
  // A missing marker would make the surviving legacy file look like a first migration.
  try { fs.writeFileSync(MIGRATION_MARKER, new Date().toISOString() + '\n', 'utf8'); } catch { /* best effort */ }
  const backup = LEGACY_DATA_FILE + '.bak';
  try {
    if (!fs.existsSync(backup)) {
      fs.renameSync(LEGACY_DATA_FILE, backup);
      console.log(`· 已备份迁移前数据 → ${backup}`);
      return;
    }
    if (sameBytes(LEGACY_DATA_FILE, backup)) {
      fs.unlinkSync(LEGACY_DATA_FILE);
      return;
    }
    const kept = freeBackupName(backup);
    fs.renameSync(LEGACY_DATA_FILE, kept);
    console.warn(`· 发现另一份 ${path.basename(LEGACY_DATA_FILE)}（与已有备份不同），已保留为 ${path.basename(kept)}`);
  } catch {
    // Best effort: the file is only harmful if the index is later lost *and* it still predates the
    // page files, so a failed move is left for the next boot to retry rather than risking further
    // filesystem work. `ensureData` above also refuses to migrate a file that has a backup.
  }
}

/**
 * Whether the legacy file has already been superseded by a migration of this data directory.
 *
 * The `.bak` alone was not enough: `onlyCreate` protects page files that exist, so a re-import kept
 * the user's edits but resurrected every page they had *deleted*, since a missing file looks exactly
 * like one the snapshot should supply. The marker is written by `retireLegacyFile` just before it
 * moves the file, so it survives a failed move and the file being copied back in — the cases that
 * were actually reachable. The `.bak` check remains for data directories migrated by an older
 * version, which has a backup but no marker.
 *
 * The one window still not covered is a crash in the instant between the store write and the retire
 * call, where nothing distinguishes a replay from a first migration. It is idempotent in effect:
 * pages already written are left alone, and the user cannot have deleted anything in a window they
 * never got to use.
 */
function legacyFileIsResidue(): boolean {
  return fs.existsSync(MIGRATION_MARKER) || fs.existsSync(LEGACY_DATA_FILE + '.bak');
}

/** Byte comparison of two files, false on any read error. */
function sameBytes(a: string, b: string): boolean {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/** First unused `<backup>.N` path, so preserving a file never clobbers an existing one. */
function freeBackupName(backup: string): string {
  for (let n = 1; ; n++) {
    const candidate = `${backup}.${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Convert a pre-store `data/pages.json` into the file layout, then retire the original to
 * `pages.json.bak`. The move is the point: leaving the original in place is what let a later
 * lost index re-import stale content over the user's edits.
 */
function migrateLegacyFile(): void {
  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8')); } catch { /* fallthrough */ }
  if (!raw || (raw.version !== 3 && raw.version !== 4)) {
    // An unreadable legacy file is not proof the site is empty: pages already in `pages/` are the
    // user's data and should be recovered before initializing an empty store.
    const salvage = recoverStore(DATA_DIR);
    retireLegacyFile();
    if (salvage) {
      console.warn('· 旧数据格式无法识别，已按现有页面恢复（页面文件未改动）');
      writeSpaces(DATA_DIR, salvage.spaces);
      return;
    }
    console.warn('· 旧数据格式无法识别，已建立空用户数据目录');
    writeDb(emptyDb(), [], { onlyCreate: true });
    return;
  }

  // Pages on disk outrank the snapshot's index: a space the user created after the snapshot was
  // taken is named by its pages' front matter but not by `spaces`, and writing that list verbatim
  // would drop the space and send its pages to the fallback on the next read.
  const live = recoverStore(DATA_DIR);
  const spaces: Space[] = mergeSpaces(raw.spaces || [], live?.spaces ?? []);
  const fromHtml = raw.version === 3;
  const pages: Page[] = (raw.pages || []).map((p: Page) => ({
    ...p,
    content: fromHtml ? htmlToMarkdown(p.content) : String(p.content ?? ''),
  }));
  // `onlyCreate`: an existing `<slug>.md` is live data and outranks this snapshot. That is what
  // makes a re-migration harmless — e.g. the legacy file survived its retirement (a crash between
  // the store write and the move) and the index was later lost, so this path runs again. Without
  // it, the stale snapshot would overwrite the user's edits; with it, only missing pages are added.
  writeDb({ version: 4, spaces, pages }, [], { onlyCreate: true });
  // Only after the store is safely written: the rename both preserves the original and stops it
  // from being treated as live data on any later boot.
  retireLegacyFile();
  console.log(
    fromHtml
      ? '· 数据已从 v3（HTML）迁移为 Markdown 文件'
      : '· 数据已从 pages.json 迁移为 Markdown 文件',
  );
}

// Cache parsed template contents while detecting changes to the index or any Markdown file.
let templateCache: { signature: string; db: Database } | null = null;
let templateUnavailable = false;
let templateVirtualSlug = BUILT_IN_SLUG;
function readBuiltInTemplate(): Database | null {
  try {
    const dir = path.join(TEMPLATE_DIR, 'pages');
    const files = [path.join(TEMPLATE_DIR, 'spaces.json'), ...fs.readdirSync(dir)
      .filter(name => name.endsWith('.md')).sort().map(name => path.join(dir, name))];
    const signature = JSON.stringify(files.map(file => {
      const stat = fs.statSync(file, { bigint: true });
      return [file, stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
    }));
    const index = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'spaces.json'), 'utf8'));
    if (!index || !Array.isArray(index.spaces) || index.spaces.some((s: unknown) => !s || typeof s !== 'object' || typeof (s as Space).slug !== 'string')) throw new Error('invalid template index');
    // A deliberate deletion in developer mode is not a broken template: show no built-in space.
    if (index.doclightBuiltInDeleted === true) { templateCache = null; templateUnavailable = false; return null; }
    const mapped = index.doclightVirtualSlug === undefined ? BUILT_IN_SLUG : index.doclightVirtualSlug;
    if (mapped !== BUILT_IN_SLUG && (typeof mapped !== 'string' || !/^[a-z0-9_]{1,80}$/.test(mapped) || mapped === 'spaces' || mapped === 'api')) throw new Error('invalid template virtual slug');
    templateVirtualSlug = mapped;
    if (!index.spaces.some((s: Space) => s.slug === 'default')) throw new Error('invalid template index');
    if (templateCache?.signature !== signature) templateCache = { signature, db: readStore(TEMPLATE_DIR) };
    if (!templateCache.db.spaces.some(s => s.slug === 'default')) throw new Error('invalid template index');
    templateUnavailable = false;
    return templateCache.db;
  } catch {
    templateCache = null;
    if (!templateUnavailable) console.warn('· 内置空间模板缺失或无效，暂不显示内置空间；用户数据仍可访问');
    templateUnavailable = true;
    return null;
  }
}

function readDb(): Database {
  // Same condition as startup: an index that exists but names no spaces cannot classify the pages,
  // and `storeExists` alone accepts it. Without this, an index emptied while the server is running
  // (sync tool, hand edit) is read as "no spaces": every page collapses onto the fallback space and
  // the next ordinary save persists that, silently reassigning pages. It is also why such a request
  // would 404 on a space move — the target space no longer exists in memory.
  if (!storeExists(DATA_DIR) || spacesIndexIsEmpty(DATA_DIR)) ensureData();
  const db = readStore(DATA_DIR);
  // The built-in marker is trusted only when constructed here, not when read from disk.
  for (const space of db.spaces) { delete space.builtIn; delete space.devEditable; }
  const template = readBuiltInTemplate();
  const source = template?.spaces.find(s => s.slug === 'default');
  if (!template || !source) return db;
  const sourcePages = template.pages.filter(p => p.space === source.slug);
  const slugs = new Set(sourcePages.map(p => p.slug));
  const virtualSlug = (slug: string) => `${BUILT_IN_SLUG}-${slug}`;
  const virtual: Space = {
    ...source, slug: templateVirtualSlug, builtIn: true, locked: true,
    ...(CONFIG.devMode ? { devEditable: true } : {}),
    home: source.home && slugs.has(source.home) ? virtualSlug(source.home) : null,
    // The template index names source files, but the API speaks in virtual page slugs: translate
    // the manual order the same way the pages themselves were translated, dropping stale entries.
    ...(source.order && source.order.length
      ? { order: source.order.filter(slug => slugs.has(slug)).map(virtualSlug) }
      : {}),
  };
  const pages = sourcePages.map(p => ({
    ...p, slug: virtualSlug(p.slug), space: templateVirtualSlug,
    parent: p.parent && slugs.has(p.parent) ? virtualSlug(p.parent) : null,
  }));
  // Never shadow a pre-existing hand-edited or migrated space with the reserved identity.
  if (db.spaces.some(s => s.slug === templateVirtualSlug) || db.pages.some(p => p.slug === templateVirtualSlug)) {
    const message = templateVirtualSlug === BUILT_IN_SLUG
      ? `数据目录中已有空间 ${BUILT_IN_SLUG}，请先备份并在 spaces.json 和页面 front matter 中将它改为其他 slug`
      : `数据目录中已有空间或页面 ${templateVirtualSlug}，请先备份并将它改为其他 slug`;
    throw Object.assign(new Error(message), { code: 503, errorCode: 'BUILT_IN_SLUG_CONFLICT' });
  }
  db.spaces.push(virtual);
  db.pages.push(...pages);
  return db;
}
/** Persist `db`. `removed` must list the slugs this request deleted or renamed away; the store
 *  unlinks only those files, never every file the new db fails to mention (see writeStore). */
function writeDb(db: Database, removed: Iterable<string> = [], options: WriteOptions = {}): void {
  const builtInSpaces = new Set(db.spaces.filter(s => s.builtIn).map(s => s.slug));
  const ordinary = options.onlyCreate ? db : {
    ...db,
    spaces: db.spaces.filter(s => !s.builtIn),
    pages: db.pages.filter(p => !builtInSpaces.has(p.space) || !isBuiltInPageSlug(p.slug)),
  };
  writeStore(DATA_DIR, ordinary, removed, { preserveLocked: !options.onlyCreate, ...options });
}

/** Refuse source edits when the resolved template and user-data trees overlap. */
function requireSeparateTemplate(): void {
  let template: string;
  let data: string;
  try { template = fs.realpathSync(TEMPLATE_DIR); data = fs.realpathSync(DATA_DIR); }
  catch { throw Object.assign(new Error('无法确认模板与数据目录互相独立'), { code: 409 }); }
  const contains = (a: string, b: string) => {
    const relative = path.relative(a, b);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  };
  if (contains(template, data) || contains(data, template)) {
    throw Object.assign(new Error('模板与数据目录重叠，禁止开发模式模板写入'), { code: 409 });
  }
}

function descendantsOf(list: Page[], slug: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of list) {
      if (p.parent && !out.has(p.slug) && (out.has(p.parent) || p.parent === slug)) { out.add(p.slug); grew = true; }
    }
  }
  return out;
}

/* ---------------------------------------------------- Content sanitizing (XSS) */

/* Markdown itself needs no tag scrubbing: `marked` output is sanitised in the browser with
   DOMPurify before it is inserted into the DOM, and raw HTML in the source is subject to the
   same pass. A regex scrubber here would instead corrupt code blocks that legitimately show
   HTML examples. The server only bounds the length (see sanitizeMarkdown in src/markdown.ts). */

function randomToken(len = 7): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < len; i++) t += abc[Math.floor(Math.random() * abc.length)];
  return t;
}
const SLUG_RE = /^[a-z0-9_]{1,80}$/;
const RESERVED_SLUGS = new Set(['spaces', BUILT_IN_SLUG]); // Reserved routes and source-owned identities.

function slugify(title: unknown): string {
  // Yuque-style slugs: lowercase letters, digits and underscores; non-English titles fall back to a random token
  const s = String(title || '').trim().toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return s || randomToken();
}

/* ------------------------------------------------------------ HTTP helpers */

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('invalid JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * The page shell with the filing footer injected, read once at startup. The footer
 * must be present in the raw response, since compliance checks inspect the HTML
 * without executing scripts; doing the substitution per request would also re-read
 * the file for every SPA deep link.
 */
let indexHtmlCache: string | null = null;

function indexHtml(basePath: string): string {
  if (indexHtmlCache === null) {
    try {
      indexHtmlCache = injectFooter(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), readFooterOptions(CONFIG));
    } catch {
      return '';
    }
  }
  // The version comes from package.json, so the footer never drifts from the release.
  if (PACKAGE_VERSION) {
    indexHtmlCache = indexHtmlCache.replace(/<span id="app-version">[^<]*<\/span>/, `<span id="app-version">v${PACKAGE_VERSION}</span>`);
  }
  // Cache only the invariant shell: the public prefix belongs to this request.
  let html = indexHtmlCache.replace(/<head>/i, `<head>\n<meta name="doclight-base-path" content="${basePath}">`);
  html = html.replace(/(<(?:link|script)\b[^>]*\b(?:href|src)=["'])\/(?!\/)/gi, `$1${basePath}/`);
  html = html.replace(/(<a\b[^>]*\bclass=["'][^"']*\bbrand\b[^"']*["'][^>]*\bhref=["'])\/(?!\/)/gi, `$1${basePath}/`);
  return html;
}

function serveStatic(res: ServerResponse, urlPath: string, basePath: string): void {
  // A malformed escape such as `/%` makes `decodeURIComponent` throw `URIError`. This runs outside
  // the request promise chain (it is called directly by `handler`), so the throw had nowhere to be
  // caught and killed the process — one request to any such path took the whole site down.
  let rel: string;
  try { rel = decodeURIComponent(urlPath.split('?')[0]); }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Request'); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback so deep links resolve to the shell
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };

  // Every route resolves to the same shell, so serve the injected copy for it.
  if (file === path.join(PUBLIC_DIR, 'index.html')) {
    const html = indexHtml(basePath);
    if (html) {
      res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }
  }

  res.writeHead(200, headers);
  // An unreadable asset (a permission change under a live server, an I/O error) makes the stream
  // emit `error`. An 'error' event with no listener is rethrown as an uncaught exception, which
  // exits the process — so one request for that file took the site down. The headers are already
  // sent by now, so a status cannot be written: destroy the connection and let the client see a
  // truncated response instead of losing the server.
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    console.error(`· 读取静态文件失败 ${file}：`, err);
    stream.destroy();
    res.destroy();
  });
  stream.pipe(res);
}

/* --------------------------------------------------------------- Auth */

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const KDF_ITERS = 100000;              // PBKDF2-SHA256 iteration count
const SESSION_TTL = 7 * 86400e3;       // sessions slide-renew for 7 days
const sessions = new Map<string, Session>(); // token -> { user, exp }
const nonces = new Map<string, number>();    // login challenges (one-shot, 60s)
const failLog = new Map<string, { n: number; ts: number }>(); // failed-login rate limit (per IP)

function readAuth(): AuthRecord | null {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
function writeAuth(auth: AuthRecord): void { fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 }); }
function ensureAuthRecord(): AuthRecord {
  let a = readAuth();
  if (!a) {
    a = { user: null, salt: crypto.randomBytes(16).toString('hex'), iters: KDF_ITERS, stored: null };
    writeAuth(a);
    console.log('· 已生成鉴权记录（等待首次初始化账号）');
  }
  return a;
}
function hmacStored(storedHex: string, nonce: string): string {
  return crypto.createHmac('sha256', Buffer.from(storedHex, 'hex')).update(nonce).digest('hex');
}
/**
 * Constant-time equality against a stored hex digest.
 *
 * The comparison always runs, even when the submitted value is not shaped like a SHA-256 digest,
 * so malformed proofs also go through a fixed-length comparison. The shape check only decides
 * the result, never whether the comparison happens.
 */
function digestMatches(expectedHex: string, submitted: string): boolean {
  const shaped = /^[a-f0-9]{64}$/.test(submitted);
  const equal = crypto.timingSafeEqual(Buffer.from(shaped ? submitted : expectedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  return equal && shaped;
}
/**
 * Constant-time equality of two account names.
 *
 * Both sides are hashed first: `timingSafeEqual` requires equal lengths, and comparing the names
 * directly would leak the stored name's length and prefix through the thrown error and the timing.
 */
function sameName(expected: string, submitted: string): boolean {
  const digest = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest();
  return crypto.timingSafeEqual(digest(expected), digest(submitted));
}
function ipOf(req: IncomingMessage): string { return req.socket.remoteAddress || 'unknown'; }
function rateLimited(req: IncomingMessage): boolean {
  const f = failLog.get(ipOf(req));
  return !!(f && f.n >= 8 && Date.now() - f.ts < 120e3);
}
function noteFail(req: IncomingMessage): void {
  const ip = ipOf(req);
  const f = failLog.get(ip) || { n: 0, ts: Date.now() };
  if (Date.now() - f.ts >= 120e3) { f.n = 0; f.ts = Date.now(); }
  f.n++; failLog.set(ip, f);
}
function parseSessionToken(req: IncomingMessage): string | null {
  const m = /(?:^|;\s*)dl_sess=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function getSession(req: IncomingMessage): { user: string; token: string } | null {
  const token = parseSessionToken(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(token); return null; }
  s.exp = Date.now() + SESSION_TTL; // slide the expiry forward
  return { user: s.user, token };
}
function issueSession(res: ServerResponse, user: string, basePath: string): void {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, exp: Date.now() + SESSION_TTL });
  res.setHeader('Set-Cookie', `dl_sess=${token}; HttpOnly; SameSite=Strict; Path=${basePath || '/'}; Max-Age=${7 * 86400}`);
  return json(res, 200, { ok: true, user });
}
function purgeExpired(): void {
  const now = Date.now();
  for (const [k, v] of nonces) if (v < now) nonces.delete(k);
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, parts: string[], basePath: string): Promise<void> {
  const action = parts[2] || '';
  const a = ensureAuthRecord();

  if (req.method === 'GET' && action === 'state') {
    const sess = getSession(req);
    return json(res, 200, {
      mode: a.user ? 'ready' : 'setup',
      authed: !!sess,
      user: sess ? sess.user : null, // never expose the account name to anonymous callers
      salt: a.salt, iters: a.iters,
    });
  }

  if (req.method === 'GET' && action === 'challenge') {
    if (!a.user) return json(res, 400, { error: '请先完成账号初始化', needSetup: true });
    purgeExpired();
    const nonce = crypto.randomBytes(16).toString('hex');
    nonces.set(nonce, Date.now() + 60e3);
    // The challenge is handed out before authentication, so it must carry only
    // what the client needs to derive the proof, never the account name.
    return json(res, 200, { nonce, salt: a.salt, iters: a.iters });
  }

  if (req.method === 'POST' && action === 'setup') {
    if (a.user) return json(res, 403, { error: '账号已初始化，请直接登录' });
    const body = await readBody(req);
    const user = String(body.user || '').trim();
    const ks = String(body.ks || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(user)) return json(res, 400, { error: '用户名仅限字母、数字、下划线、连字符（≤40 位）' });
    if (!/^[a-f0-9]{64}$/.test(ks)) return json(res, 400, { error: '密钥格式非法' });
    a.user = user; a.stored = ks;
    writeAuth(a);
    console.log(`· 站长账号已初始化：${user}`);
    return issueSession(res, user, basePath);
  }

  if (req.method === 'POST' && action === 'login') {
    if (!a.user) return json(res, 400, { error: '请先完成账号初始化', needSetup: true });
    if (rateLimited(req)) return json(res, 429, { error: '尝试过于频繁，请两分钟后再试' });
    const body = await readBody(req);
    const nonce = String(body.nonce || '');
    const exp = nonces.get(nonce);
    if (!exp || Date.now() > exp) return json(res, 400, { error: '挑战已过期，请重试' });
    nonces.delete(nonce); // one-shot to block replay
    if (!a.stored) return json(res, 500, { error: '鉴权记录损坏，请重新初始化' });
    // Check both the account name and proof on every attempt without short-circuiting either
    // comparison; wrong names and wrong passwords receive the same response.
    const proof = String(body.proof || '');
    const name = typeof body.user === 'string' ? body.user.trim() : '';
    const proofOk = digestMatches(hmacStored(a.stored, nonce), proof);
    const nameOk = sameName(a.user, name);
    if (!(proofOk && nameOk)) { noteFail(req); return json(res, 401, { error: '用户名或密码错误' }); }
    failLog.delete(ipOf(req));
    return issueSession(res, a.user, basePath);
  }

  if (req.method === 'POST' && action === 'logout') {
    const sess = getSession(req);
    if (sess) sessions.delete(sess.token);
    res.setHeader('Set-Cookie', `dl_sess=; HttpOnly; SameSite=Strict; Path=${basePath || '/'}; Max-Age=0`);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not Found' });
}

/* --------------------------------------------------------------- Routing */

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, basePath: string): Promise<void> {
  const parts = pathname.split('/').filter(Boolean); // ['api','pages',':slug?']
  const key = parts[1] || '';

  /* Auth endpoints */
  if (key === 'auth') return handleAuth(req, res, parts, basePath);

  /* Document writes require a session (reads stay public) */
  if ((key === 'pages' || key === 'spaces') && req.method !== 'GET') {
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: '请先登录后再修改', needAuth: true });
  }

  // Read bodies before taking the snapshot: no await may separate a write's read and commit.
  const body = (key === 'pages' || key === 'spaces') && (req.method === 'POST' || req.method === 'PUT')
    ? await readBody(req) : {};
  // A session may have been revoked while a slow request body was arriving.
  if ((key === 'pages' || key === 'spaces') && req.method !== 'GET' && !getSession(req)) {
    return json(res, 401, { error: '请先登录后再修改', needAuth: true });
  }
  const db = readDb();
  const builtInSpace = db.spaces.find(s => s.builtIn)?.slug;
  const isLocked = (slug: string) => slug === builtInSpace || slug === BUILT_IN_SLUG || db.spaces.some(s => s.slug === slug && s.locked === true);
  const locked = () => json(res, 423, { error: '空间已锁定' });

  /* Full tree: spaces + page metadata */
  if (req.method === 'GET' && key === 'tree' && parts.length === 2) {
    return json(res, 200, {
      spaces: db.spaces,
      pages: db.pages.map(({ content, ...meta }) => meta),
    });
  }

  /* ---- Spaces ---- */
  if (key === 'spaces') {
    if (req.method === 'POST' && parts.length === 2) {
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) return json(res, 400, { error: '请提供空间名称' });
      const desc = String(body.desc || '').trim().slice(0, 200);
      const taken = (s: string) => db.pages.some(p => p.slug === s) || db.spaces.some(x => x.slug === s) || RESERVED_SLUGS.has(s);
      let slug = slugify(title);
      while (taken(slug)) slug = slugify(title) + '_' + randomToken(4);
      const now = Date.now();
      const space: Space = { slug, title, desc, home: null, createdAt: now, updatedAt: now };
      db.spaces.push(space);
      writeDb(db);
      return json(res, 201, space);
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'lock') {
      const slug = decodeURIComponent(parts[2]);
      const space = db.spaces.find(s => s.slug === slug);
      if (!space) return json(res, 404, { error: '空间不存在' });
      if (slug === builtInSpace || slug === BUILT_IN_SLUG) return locked();
      if (typeof body.locked !== 'boolean') return json(res, 400, { error: 'locked 参数必须为布尔值' });
      if (!body.locked) {
        if (rateLimited(req)) return json(res, 429, { error: '尝试过于频繁，请两分钟后再试' });
        const nonce = String(body.nonce || '');
        const exp = nonces.get(nonce);
        if (!exp || Date.now() > exp) return json(res, 400, { error: '挑战已过期，请重试' });
        nonces.delete(nonce);
        const auth = ensureAuthRecord();
        if (!auth.user) return json(res, 400, { error: '请先完成站长账号初始化，再解锁空间' });
        if (!auth.stored) return json(res, 500, { error: '鉴权记录损坏，请重新初始化' });
        const proof = String(body.proof || '');
        // Same verifier as the login route, but the name is deliberately not required here: an
        // unlock is authorized by the session plus a fresh password proof.
        const ok = digestMatches(hmacStored(auth.stored, nonce), proof);
        if (!ok) { noteFail(req); return json(res, 401, { error: '用户名或密码错误' }); }
        failLog.delete(ipOf(req));
        delete space.locked;
      } else {
        space.locked = true;
      }
      space.updatedAt = Date.now();
      writeSpaces(DATA_DIR, db.spaces.filter(s => !s.builtIn));
      return json(res, 200, space);
    }
    if (parts.length === 3) {
      const slug = decodeURIComponent(parts[2]);
      const idx = db.spaces.findIndex(s => s.slug === slug);
      if (req.method === 'PUT') {
        if (idx < 0) return json(res, 404, { error: '空间不存在' });
        if (slug === builtInSpace && CONFIG.devMode) {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['title', 'desc', 'sort', 'order', 'recommend', 'slug'].includes(k))) return locked();
          const changes: { title?: string; desc?: string; sort?: SortKey | null; order?: string[] | null; recommend?: boolean | null; virtualSlug?: string } = {};
          if (body.slug !== undefined) {
            if (Object.keys(body).length !== 1 || typeof body.slug !== 'string' || (body.slug !== BUILT_IN_SLUG && (!SLUG_RE.test(body.slug) || body.slug === 'spaces' || body.slug === 'api'))) return json(res, 400, { error: '空间 slug 无效或不能与其他修改同时提交' });
            if (body.slug !== slug && (db.pages.some(p => p.slug === body.slug) || db.spaces.some(s => s.slug === body.slug))) return json(res, 409, { error: '该 slug 已被占用' });
            if (body.slug !== slug && SLUG_RE.test(body.slug)) {
              try { fs.lstatSync(path.join(DATA_DIR, 'pages', `${body.slug}.md`)); return json(res, 409, { error: '该 slug 已被占用' }); }
              catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
            }
            changes.virtualSlug = body.slug;
          }
          if (body.title !== undefined) {
            if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) return json(res, 400, { error: '空间名称须为 1–120 个字符' });
            changes.title = body.title.trim();
          }
          if (body.desc !== undefined) {
            if (typeof body.desc !== 'string' || body.desc.trim().length > 200) return json(res, 400, { error: '空间描述须为不超过 200 个字符' });
            changes.desc = body.desc.trim();
          }
          if (body.sort !== undefined) {
            if (body.sort !== null && !isSortKey(body.sort)) return json(res, 400, { error: `sort 只能是 ${SORT_KEYS.join(' / ')} 或 null` });
            changes.sort = body.sort as SortKey | null;
          }
          if (body.recommend !== undefined) {
            if (typeof body.recommend !== 'boolean') return json(res, 400, { error: 'recommend 参数必须为布尔值' });
            // `false` is the default, so it clears the key instead of pinning it in the template.
            changes.recommend = body.recommend ? true : null;
          }
          if (body.order !== undefined) {
            if (!Array.isArray(body.order)) return json(res, 400, { error: 'order 必须是页面 slug 数组' });
            // The browser knows the built-in pages by their virtual `doclight-default-…` names;
            // the template index stores the source file names, so they are translated here.
            const seen = new Set<string>();
            const sourceOrder: string[] = [];
            for (const item of body.order) {
              if (typeof item !== 'string' || !isBuiltInPageSlug(item) || !db.pages.some(p => p.slug === item && p.space === builtInSpace)) {
                return json(res, 400, { error: 'order 只能包含本空间内页面的 slug' });
              }
              if (seen.has(item)) return json(res, 400, { error: 'order 中不能出现重复的 slug' });
              seen.add(item);
              sourceOrder.push(item.slice(BUILT_IN_SLUG.length + 1));
            }
            changes.order = sourceOrder.length ? sourceOrder : null;
          }
          // Entering manual mode seeds the order from what was on screen, so the first drag starts
          // from the current arrangement instead of an arbitrary one.
          if (body.sort === 'manual' && changes.order === undefined) {
            const seeded = db.pages.filter(p => p.space === slug).map(p => p.slug.slice(BUILT_IN_SLUG.length + 1));
            changes.order = seeded.length ? seeded : null;
          }
          requireSeparateTemplate();
          editTemplateSpace(TEMPLATE_DIR, changes);
          templateCache = null;
          const updated = readDb().spaces.find(s => s.builtIn);
          if (!updated) throw new Error('updated template space is unavailable');
          return json(res, 200, updated);
        }
        if (isLocked(slug)) return locked();
        // Validate all fields before applying anything: an early return must not leave a
        // partially updated tree behind (a slug rename also re-points every page, so it
        // has to be committed together with the rest).
        let nextSlug: string | null = null;
        if (body.slug !== undefined) {
          const ns = String(body.slug || '').trim();
          if (!SLUG_RE.test(ns)) return json(res, 400, { error: 'slug 只能含小写字母、数字、下划线（1–80 位）' });
          if (RESERVED_SLUGS.has(ns)) return json(res, 400, { error: '该 slug 为系统保留字' });
          if (ns !== slug && (db.pages.some(p => p.slug === ns) || db.spaces.some(s => s.slug === ns))) {
            return json(res, 400, { error: '该 slug 已被占用' });
          }
          if (ns !== slug) nextSlug = ns;
        }
        let nextTitle: string | null = null;
        if (body.title !== undefined) {
          const t = String(body.title).trim().slice(0, 120);
          if (!t) return json(res, 400, { error: '空间名称不能为空' });
          nextTitle = t;
        }
        // `null` clears the preference back to the default, so the key can stay out of the file
        // rather than being pinned to whatever the default happened to be at the time.
        let nextSort: SortKey | null = null;
        if (body.sort !== undefined) {
          if (body.sort === null) nextSort = null;
          else if (isSortKey(body.sort)) nextSort = body.sort;
          else return json(res, 400, { error: `sort 只能是 ${SORT_KEYS.join(' / ')} 或 null` });
        }
        let nextRecommend: boolean | undefined;
        if (body.recommend !== undefined) {
          if (typeof body.recommend !== 'boolean') return json(res, 400, { error: 'recommend 参数必须为布尔值' });
          nextRecommend = body.recommend;
        }
        let nextOrder: string[] | undefined;
        if (body.order !== undefined) {
          if (!Array.isArray(body.order)) return json(res, 400, { error: 'order 必须是页面 slug 数组' });
          const seen = new Set<string>();
          for (const item of body.order) {
            if (typeof item !== 'string' || !db.pages.some(p => p.slug === item && p.space === slug)) {
              return json(res, 400, { error: 'order 只能包含本空间内页面的 slug' });
            }
            if (seen.has(item)) return json(res, 400, { error: 'order 中不能出现重复的 slug' });
            seen.add(item);
          }
          nextOrder = body.order as string[];
        }

        if (nextSlug !== null) {
          const ns = nextSlug;
          db.pages.forEach(p => { if (p.space === slug) p.space = ns; });
          db.spaces[idx].slug = ns;
        }
        if (nextTitle !== null) db.spaces[idx].title = nextTitle;
        if (body.desc !== undefined) db.spaces[idx].desc = String(body.desc).trim().slice(0, 200);
        if (body.sort !== undefined) {
          if (nextSort === null) delete db.spaces[idx].sort;
          else db.spaces[idx].sort = nextSort;
        }
        if (nextRecommend !== undefined) {
          // Only the enabled state is persisted: a disabled space keeps no `recommend` key.
          if (nextRecommend) db.spaces[idx].recommend = true;
          else delete db.spaces[idx].recommend;
        }
        if (nextOrder !== undefined) {
          if (nextOrder.length) db.spaces[idx].order = nextOrder;
          else delete db.spaces[idx].order;
        }
        // Entering manual mode seeds the order from the arrangement already on screen.
        if (body.sort === 'manual' && nextOrder === undefined && !db.spaces[idx].order) {
          db.spaces[idx].order = db.pages.filter(p => p.space === db.spaces[idx].slug).map(p => p.slug);
        }
        db.spaces[idx].updatedAt = Date.now();
        writeDb(db);
        return json(res, 200, db.spaces[idx]);
      }
      if (req.method === 'DELETE') {
        if (idx < 0) return json(res, 404, { error: '空间不存在' });
        if (slug === builtInSpace && CONFIG.devMode) {
          let removedSources: string[];
          try { removedSources = deleteTemplateSpace(templateDirs()); }
          catch (error) { return json(res, templateErrorStatus(error), { error: (error as Error).message }); }
          templateCache = null;
          return json(res, 200, { ok: true, removedSpace: slug, removedPages: removedSources.map(source => `${BUILT_IN_SLUG}-${source}`) });
        }
        if (isLocked(slug)) return locked();
        const spaceSlug = db.spaces[idx].slug;
        const removedPages = db.pages.filter(p => p.space === spaceSlug).map(p => p.slug);
        if (db.pages.some(p => p.parent && removedPages.includes(p.parent) && isLocked(p.space)) ||
            db.spaces.some(s => isLocked(s.slug) && s.home && removedPages.includes(s.home))) return locked();
        db.pages = db.pages.filter(p => p.space !== spaceSlug);
        db.spaces.splice(idx, 1);
        writeDb(db, removedPages);
        return json(res, 200, { ok: true, removedSpace: spaceSlug, removedPages });
      }
    }
  }

  /* ---- Pages ---- */
  if (key === 'pages' && req.method === 'GET' && parts.length === 2) {
    return json(res, 200, db.pages.map(({ content, ...meta }) => meta));
  }
  if (key === 'pages' && parts.length === 3) {
    const slug = decodeURIComponent(parts[2]);
    const idx = db.pages.findIndex(p => p.slug === slug);

    if (req.method === 'GET') {
      if (idx < 0) return json(res, 404, { error: '页面不存在' });
      return json(res, 200, db.pages[idx]);
    }
    if (req.method === 'PUT') {
      if (idx < 0) return json(res, 404, { error: '页面不存在' });
      if (isBuiltInPageSlug(slug) && db.pages[idx].space === builtInSpace) {
        if (!CONFIG.devMode) return locked();
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'title' && k !== 'content' && k !== 'parent' && k !== 'slug' && k !== 'space')) return locked();
        // Moving a built-in page subtree into an ordinary space rewrites every moved file.
        if (body.space !== undefined) {
          if (Object.keys(body).some(k => k !== 'space' && k !== 'parent')) return locked();
          if (typeof body.space !== 'string' || body.space === builtInSpace || body.space === BUILT_IN_SLUG) {
            return json(res, 400, { error: '目标空间无效' });
          }
          const targetSpace = db.spaces.find(s => s.slug === body.space && !s.builtIn);
          if (!targetSpace) return json(res, 404, { error: '目标空间不存在' });
          const parent = body.parent === undefined || body.parent === null ? null : body.parent;
          if (parent !== null && typeof parent !== 'string') return json(res, 400, { error: 'parent 参数非法' });
          let movedSlugs: string[];
          try { movedSlugs = moveTemplatePageToSpace(templateDirs(), slug.slice(BUILT_IN_SLUG.length + 1), body.space, parent); }
          catch (error) { return json(res, templateErrorStatus(error), { error: (error as Error).message }); }
          templateCache = null;
          const movedTree = readDb();
          const moved = movedTree.pages.find(p => p.slug === movedSlugs[0] && p.space === body.space);
          if (!moved) throw new Error('moved page is unavailable');
          return json(res, 200, moved);
        }
        // A source slug rename rewrites the file name, every direct child and the space home.
        if (body.slug !== undefined) {
          if (Object.keys(body).length !== 1 || typeof body.slug !== 'string') return json(res, 400, { error: '页面 slug 只能单独提交' });
          const nextSlug = body.slug.trim();
          if (!SLUG_RE.test(nextSlug)) return json(res, 400, { error: 'slug 只能含小写字母、数字、下划线（1–80 位）' });
          if (RESERVED_SLUGS.has(nextSlug)) return json(res, 400, { error: '该 slug 为系统保留字' });
          const target = `${BUILT_IN_SLUG}-${nextSlug}`;
          if (target !== slug && (db.pages.some(p => p.slug === target) || db.spaces.some(s => s.slug === nextSlug || s.slug === target))) {
            return json(res, 409, { error: '该 slug 已被占用' });
          }
          let removed: string[];
          try { removed = renameTemplatePage(templateDirs(), slug.slice(BUILT_IN_SLUG.length + 1), nextSlug); }
          catch (error) { return json(res, templateErrorStatus(error), { error: (error as Error).message }); }
          templateCache = null;
          const renamed = readDb().pages.find(p => p.slug === target && p.space === builtInSpace);
          if (!renamed) return json(res, 409, { error: `页面已改名为 ${removed.length ? target : slug}，请刷新后重试` });
          return json(res, 200, renamed);
        }
        const changes: { title?: string; content?: string; parent?: string | null } = {};
        if (body.parent !== undefined) {
          const parent = body.parent;
          if (parent !== null && typeof parent !== 'string') return json(res, 400, { error: 'parent 参数非法' });
          if (parent === slug) return json(res, 400, { error: '不能移动到自身之下' });
          if (parent) {
            const target = db.pages.find(p => p.slug === parent && p.space === builtInSpace);
            if (!target || !isBuiltInPageSlug(parent)) return json(res, 400, { error: '父级必须位于同一空间' });
            if (descendantsOf(db.pages, slug).has(parent)) return json(res, 400, { error: '不能移动到自己的子页面之下' });
            // Confirm ownership from the target's raw YAML, not readStore's fallback mapping.
            editTemplatePage(TEMPLATE_DIR, parent.slice(BUILT_IN_SLUG.length + 1), {});
          }
          changes.parent = parent ? parent.slice(BUILT_IN_SLUG.length + 1) : null;
        }
        if (body.title !== undefined) {
          if (typeof body.title !== 'string') return json(res, 400, { error: '标题必须为字符串' });
          changes.title = body.title.trim();
          if (!changes.title) return json(res, 400, { error: '标题不能为空' });
          if (changes.title.length > 120) return json(res, 400, { error: '标题不能超过 120 字符' });
        }
        if (body.content !== undefined) {
          if (typeof body.content !== 'string') return json(res, 400, { error: '内容必须为字符串' });
          if (body.content.replace(/\r\n/g, '\n').length > 500 * 1024) return json(res, 400, { error: '内容超过 500 KiB 限制' });
          changes.content = sanitizeMarkdown(body.content);
        }
        requireSeparateTemplate();
        editTemplatePage(TEMPLATE_DIR, slug.slice(BUILT_IN_SLUG.length + 1), changes);
        templateCache = null;
        const updated = readDb().pages.find(p => p.slug === slug && p.space === builtInSpace);
        if (!updated) throw new Error('updated template page is unavailable');
        return json(res, 200, updated);
      }
      if (CONFIG.devMode && builtInSpace && body.space === builtInSpace) {
        if (Object.keys(body).some(k => k !== 'space' && k !== 'parent')) return locked();
        if (body.parent !== undefined && body.parent !== null) return json(res, 400, { error: '移入内置空间时只能移动到顶层' });
        let movedSlugs: string[];
        try { movedSlugs = moveDataPageToTemplate(templateDirs(), slug); }
        catch (error) { return json(res, templateErrorStatus(error), { error: (error as Error).message }); }
        templateCache = null;
        const moved = readDb().pages.find(p => p.slug === `${BUILT_IN_SLUG}-${movedSlugs[0]}` && p.space === builtInSpace);
        if (!moved) throw new Error('moved template page is unavailable');
        return json(res, 200, moved);
      }
      if (isBuiltInPageSlug(slug) || isLocked(db.pages[idx].space)) return locked();
      if (typeof body.space === 'string' && isLocked(body.space)) return locked();
      if (typeof body.space === 'string' && body.space !== db.pages[idx].space &&
          (db.pages.some(p => p.parent === slug && isLocked(p.space)) ||
           db.spaces.some(s => s.home === slug && isLocked(s.slug)))) return locked();
      // A rename rewrites direct children and home pointers, even in inconsistent cross-space trees.
      if (body.slug !== undefined && String(body.slug || '').trim() !== slug &&
          (db.pages.some(p => p.parent === slug && isLocked(p.space)) ||
           db.spaces.some(s => s.home === slug && isLocked(s.slug)))) return locked();
      let renamed = false;
      if (body.slug !== undefined) {
        const ns = String(body.slug || '').trim();
        if (!SLUG_RE.test(ns)) return json(res, 400, { error: 'slug 只能含小写字母、数字、下划线（1–80 位）' });
        if (RESERVED_SLUGS.has(ns)) return json(res, 400, { error: '该 slug 为系统保留字' });
        if (ns !== slug && (db.pages.some(p => p.slug === ns) || db.spaces.some(s => s.slug === ns))) {
          return json(res, 400, { error: '该 slug 已被占用' });
        }
        if (ns !== slug) {
          renamed = true;
          db.pages.forEach(p => { if (p.parent === slug) p.parent = ns; });
          db.pages[idx].slug = ns;
          const sp = db.spaces.find(s => s.home === slug);
          if (sp) sp.home = ns;
          // The manual order stores slugs, so a rename has to follow it. Leaving the old slug behind
          // would drop the page out of the position the drag-and-drop editor gave it — it would
          // sink to the end of the space — and keep a ghost entry that a later page could inherit.
          const space = db.spaces.find(s => s.slug === db.pages[idx].space);
          if (space) {
            const ordered = renameInOrder(space.order, slug, ns);
            if (ordered !== space.order) space.order = ordered;
          }
        }
      }
      if (body.space !== undefined) {
        const ns = body.space || null;
        if (typeof ns !== 'string') return json(res, 400, { error: 'space 参数非法' });
        if (!db.spaces.some(s => s.slug === ns)) return json(res, 404, { error: '目标空间不存在' });
        // A request may rename and move the same page; read the live slug so the order and home
        // cleanups below match the name the page actually has by now.
        const live = db.pages[idx].slug;
        const old = db.pages[idx].space;
        db.pages[idx].space = ns;
        const oldSp = db.spaces.find(s => s.slug === old);
        if (oldSp && old !== ns) {
          if (oldSp.home === live) oldSp.home = null;
          // Moving the page out of its space leaves its manual position behind; a stale entry would
          // be rejected when the arrangement is re-submitted and could be inherited by a page later
          // minted under the same slug. The target space appends it as a new, unarranged page.
          const ordered = removeFromOrder(oldSp.order, [live]);
          if (ordered !== oldSp.order) {
            if (ordered) oldSp.order = ordered;
            else delete oldSp.order;
          }
        }
      }
      if (body.parent !== undefined) {
        const parent = body.parent || null;
        if (parent !== null && typeof parent !== 'string') return json(res, 400, { error: 'parent 参数非法' });
        const liveSlug = db.pages[idx].slug;
        if (parent === slug || parent === liveSlug) return json(res, 400, { error: '不能移动到自身之下' });
        if (parent) {
          const pp = db.pages.find(p => p.slug === parent);
          if (!pp) return json(res, 404, { error: '目标父级不存在' });
          if (pp.space !== db.pages[idx].space) return json(res, 400, { error: '父级必须位于同一空间' });
          if (descendantsOf(db.pages, liveSlug).has(parent)) return json(res, 400, { error: '不能移动到自己的子页面之下' });
        }
        db.pages[idx].parent = parent;
      }
      if (body.title !== undefined) {
        const t = String(body.title).trim().slice(0, 120);
        if (!t) return json(res, 400, { error: '标题不能为空' });
        db.pages[idx].title = t;
      }
      if (body.content !== undefined) db.pages[idx].content = sanitizeMarkdown(body.content);
      db.pages[idx].updatedAt = Date.now();
      // A slug rename leaves the old file behind, so it is declared for removal here; the store
      // keeps it if the new slug happens to reuse the same name.
      writeDb(db, renamed ? [slug] : []);
      return json(res, 200, db.pages[idx]);
    }
    if (req.method === 'DELETE') {
      if (idx < 0) return json(res, 404, { error: '页面不存在' });
      if (db.pages[idx].space === builtInSpace && isBuiltInPageSlug(slug)) {
        if (!CONFIG.devMode) return locked();
        let removedSources: string[];
        try { removedSources = deleteTemplateSubtree(templateDirs(), slug.slice(BUILT_IN_SLUG.length + 1)); }
        catch (error) { return json(res, templateErrorStatus(error), { error: (error as Error).message }); }
        templateCache = null;
        return json(res, 200, { ok: true, removed: removedSources.map(source => `${BUILT_IN_SLUG}-${source}`) });
      }
      const doomed = [slug, ...descendantsOf(db.pages, slug)];
      if (db.pages.some(p => doomed.includes(p.slug) && isLocked(p.space)) ||
          db.spaces.some(s => isLocked(s.slug) && s.home && doomed.includes(s.home))) return locked();
      db.pages = db.pages.filter(p => !doomed.includes(p.slug));
      // Any space whose home was among the removed pages (the page itself or a descendant)
      // would otherwise keep a pointer to a slug that no longer resolves.
      for (const sp of db.spaces) {
        if (sp.builtIn) continue;
        if (sp.home && doomed.includes(sp.home)) sp.home = null;
        // Deleted pages also leave the manual order, for the same reason the renamed ones do: an
        // entry naming a page that no longer exists is rejected when the arrangement is
        // re-submitted, and a page later created under that slug would inherit the dead position.
        const ordered = removeFromOrder(sp.order, doomed);
        if (ordered !== sp.order) {
          if (ordered) sp.order = ordered;
          else delete sp.order;
        }
      }
      writeDb(db, doomed);
      return json(res, 200, { ok: true, removed: doomed });
    }
  }

  if (req.method === 'POST' && key === 'pages' && parts.length === 2) {
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return json(res, 400, { error: '请提供页面标题' });
    const space = String(body.space || '');
    if (!db.spaces.some(s => s.slug === space)) return json(res, 404, { error: '目标空间不存在' });
    if (isLocked(space) && !(space === builtInSpace && CONFIG.devMode)) return locked();
    const parent = body.parent === undefined ? null : body.parent;
    if (parent !== null && typeof parent !== 'string') return json(res, 400, { error: 'parent 参数非法' });
    if (parent) {
      const pp = db.pages.find(p => p.slug === parent);
      if (!pp) return json(res, 404, { error: '目标父级不存在' });
      if (pp.space !== space) return json(res, 400, { error: '父级必须位于同一空间' });
    }
    if (space === builtInSpace) {
      if (parent) editTemplatePage(TEMPLATE_DIR, parent.slice(BUILT_IN_SLUG.length + 1), {});
      const base = slugify(title).slice(0, 70);
      let sourceSlug = base;
      const taken = (s: string) => db.pages.some(p => p.slug === `${BUILT_IN_SLUG}-${s}`) || db.spaces.some(x => x.slug === s) || RESERVED_SLUGS.has(s);
      while (taken(sourceSlug)) sourceSlug = base + '_' + randomToken(4);
      const now = Date.now();
      const page: Page = { slug: sourceSlug, space: 'default', parent: parent ? parent.slice(BUILT_IN_SLUG.length + 1) : null, title, content: '', createdAt: now, updatedAt: now };
      requireSeparateTemplate();
      try { createTemplatePage(TEMPLATE_DIR, page); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return json(res, 409, { error: '模板页面目标已存在' });
        throw err;
      }
      templateCache = null;
      const created = readDb().pages.find(p => p.slug === `${BUILT_IN_SLUG}-${sourceSlug}` && p.space === builtInSpace);
      if (!created) throw new Error('created template page is unavailable');
      return json(res, 201, created);
    }
    const taken = (s: string) => db.pages.some(p => p.slug === s) || db.spaces.some(x => x.slug === s) || RESERVED_SLUGS.has(s);
    let slug = slugify(title);
    const base = slug;
    while (taken(slug)) slug = base + '_' + randomToken(4);
    const page: Page = { slug, space, parent, title, content: '', createdAt: Date.now(), updatedAt: Date.now() };
    db.pages.push(page);
    writeDb(db);
    return json(res, 201, page);
  }

  return json(res, 404, { error: 'Not Found' });
}

/** Infer only from the request target, never from proxy-controlled headers. Ambiguous
 * routes fall back to root; operators can pin basePath when that is insufficient. */
function discoverBasePath(pathname: string): string {
  const segments = pathname.split('/').slice(1);
  const isAsset = (suffix: string) => {
    if (!/^\/[A-Za-z0-9._~/-]+$/.test(suffix) || suffix.split('/').some(s => s === '.' || s === '..')) return false;
    const file = path.resolve(PUBLIC_DIR, '.' + suffix);
    try { return file.startsWith(PUBLIC_DIR + path.sep) && fs.statSync(file).isFile(); } catch { return false; }
  };
  const isApi = (suffix: string) => suffix === '/api' || suffix.startsWith('/api/');
  if (isApi(pathname) || isAsset(pathname) || pathname === '/spaces' || pathname === '/spaces/') return '';

  let db: Database;
  try { db = readDb(); } catch { return ''; }
  const space = (s: string) => db.spaces.some(x => x.slug === s);
  const page = (s: string) => db.pages.some(x => x.slug === s);
  // A known root slug always wins, even if a later segment resembles an API or asset.
  if (space(segments[0]) || page(segments[0])) return '';
  const safePrefix = (parts: string[]) => parts.length > 0 && parts.every(s => /^[A-Za-z0-9._~-]+$/.test(s) && s !== '.' && s !== '..');
  const candidates: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i);
    if (!safePrefix(prefix)) continue;
    const suffix = '/' + segments.slice(i).join('/');
    if (isApi(suffix) || isAsset(suffix)) candidates.push('/' + prefix.join('/'));
  }
  if (candidates.length) return candidates.length === 1 ? candidates[0] : '';
  // Prefer a space route over its final page slug; the latter is not an independent
  // candidate when it is part of that same known space route.
  const routeCandidates: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i);
    if (!safePrefix(prefix)) continue;
    const rest = segments.slice(i).filter(Boolean);
    if (rest.length && (space(rest[0]) && rest.slice(1).every(s => db.pages.some(p => p.slug === s && p.space === rest[0])) ||
        rest.length === 1 && (page(rest[0]) || rest[0] === 'spaces'))) {
      routeCandidates.push('/' + prefix.join('/'));
      if (space(rest[0])) break;
    }
  }
  if (routeCandidates.length === 1) return routeCandidates[0];
  // A single unknown segment may be a mount root, with or without a trailing slash.
  // Known slugs win above; explicit basePath resolves inherently ambiguous cases.
  if ((segments.length === 1 || (segments.length === 2 && segments[1] === '')) && safePrefix([segments[0]])) return '/' + segments[0];
  return '';
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  // Parsing the request target can itself throw: an absolute-form target such as
  // `GET http://[ HTTP/1.1` (sendable by any raw socket, `curl --request-target` or a scanner)
  // makes `new URL` raise `ERR_INVALID_URL`. Browsers never send that form, but this line runs
  // outside the request promise chain, so the bare throw killed the process — the same
  // take-the-whole-site-down class as the malformed escape in `serveStatic`.
  let pathname: string;
  try { pathname = new URL(req.url || '/', 'http://x').pathname; }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Request'); return; }
  const basePath = CONFIG.basePathExplicit ? CONFIG.basePath : discoverBasePath(pathname);
  // Explicit configuration also supports a proxy that has already stripped the prefix.
  if (basePath && (pathname === basePath || pathname.startsWith(basePath + '/'))) {
    pathname = pathname.slice(basePath.length) || '/';
  }
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
  });

  Promise.resolve(pathname.startsWith('/api/') ? handleApi(req, res, pathname, basePath) : null)
    .catch((err: unknown) => {
      // Deliberate failures carry a numeric `code` (413 body too large, 400 invalid JSON) and a
      // message written for the caller. Everything else is an unexpected fault: `fs` and most Node
      // errors use a *string* code (`EACCES`, `ENOTDIR`, `ENOSPC`), and passing one of those to
      // `writeHead` throws `ERR_HTTP_INVALID_STATUS_CODE` — which, thrown from inside a `.catch`,
      // escaped as an unhandled rejection and killed the process. Any failed write (a read-only
      // mount, a full disk) took the whole site down instead of returning an error.
      const error = err as { code?: unknown; message?: string; errorCode?: unknown };
      const status = typeof error.code === 'number' && error.code >= 400 && error.code <= 599
        ? error.code
        : 500;
      const conflict = status === 503 && error.errorCode === 'BUILT_IN_SLUG_CONFLICT';
      if (status >= 500 && !conflict) {
        console.error(`· ${req.method} ${pathname} 处理失败：`, err);
      }
      // Only deliberate client errors and the explicitly identified conflict are safe to expose.
      // Other server errors can contain filesystem paths or other implementation details.
      const message = status >= 500 && !conflict ? '服务器内部错误' : (error.message || '请求失败');
      // A handler that already responded and then threw must not be answered twice; `writeHead`
      // would throw ERR_HTTP_HEADERS_SENT and we would be back to a crashed process.
      if (res.headersSent) { res.end(); return; }
      if (conflict) console.warn('· BUILT_IN_SLUG_CONFLICT：用户空间与内置空间的保留 slug 冲突');
      json(res, status, conflict ? { error: message, errorCode: 'BUILT_IN_SLUG_CONFLICT' } : { error: message });
    });

  if (!pathname.startsWith('/api/')) serveStatic(res, pathname, basePath);
}

/* ------------------------------------------------- Free-port startup scan */

function listen(server: Server, port: number, retriesLeft: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EADDRINUSE' && retriesLeft > 0) resolve(listen(server, port + 1, retriesLeft - 1, host));
      else reject(err);
    });
    server.listen(port, host, () => resolve(port));
  });
}

async function main(): Promise<void> {
  if (CONFIG.devMode) console.warn('· 警告：DOCLIGHT_DEV_MODE 已启用，已登录用户可直接修改内置模板源文件；公开监听存在风险');
  ensureData();
  // Finish a structural edit that was interrupted by a crash before serving any request.
  if (CONFIG.devMode) {
    try { recoverTemplateTransaction(templateDirs()); }
    catch (error) { console.warn(`· 未完成的内置模板结构事务无法自动恢复：${(error as Error).message}`); }
  }
  const startPort = CONFIG.port;
  const host = CONFIG.host; // undefined = all interfaces
  // Port scanning suits interactive local use, but a service manager must fail
  // loudly instead of silently drifting to another port (the reverse proxy points
  // at one specific port). strictPort disables the scan.
  const retries = CONFIG.strictPort ? 0 : 50;
  const server = http.createServer(handler);
  try {
    const port = await listen(server, startPort, retries, host);
    // The package may live in a read-only store, so a failure here is expected
    // and harmless: the PID file is only a local-development convenience.
    try { fs.writeFileSync(path.join(ROOT, '.server.pid'), String(process.pid)); } catch { /* ignore */ }
    console.log(`\n  ✦ DocLight 文档站已就绪 (PID ${process.pid})`);
    console.log(`    本机访问  http://localhost:${port}`);
    console.log(`    数据目录  ${DATA_DIR}\n`);
  } catch (err) {
    console.error('启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
main();
