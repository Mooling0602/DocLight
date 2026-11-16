/*
 * Crash-safe multi-file edits for the source-backed built-in documentation.
 *
 * Developer mode may change several template files for one logical action (rename a page,
 * delete a subtree, delete the built-in space). A plain sequence of `fs.renameSync`/`unlinkSync`
 * calls cannot be atomic, so every such action is written as one redo journal before any file
 * changes: a crash leaves the journal behind and the next run replays it to completion.
 *
 * Concurrency rules:
 *   - the callback runs synchronously, so nothing else in this Node process can interleave with
 *     it; re-entering a transaction while one is active is a programming error and throws;
 *   - other DocLight processes using the same state directory are excluded by a SQLite lock;
 *   - every participant must pass the same absolute, existing, private `stateDir` on one local
 *     filesystem. Different state directories cannot see each other and do not exclude each other;
 *   - NFS, multi-host mounts and programs editing the roots at the same time are unsupported: the
 *     journal guarantees recovery, not isolation from uncooperative writers.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export type TransactionRoot = 'template' | 'data';
export interface TemplateTransactionOptions {
  templateDir: string;
  dataDir: string;
  stateDir: string;
}

export interface TemplateTransaction {
  /** Read a staged or on-disk file. A missing file throws an error whose `code` is `ENOENT`. */
  read(root: TransactionRoot, relativePath: string): Buffer;
  exists(root: TransactionRoot, relativePath: string): boolean;
  /** Direct child file names of a directory, sorted, from the staged or on-disk view. */
  list(root: TransactionRoot, relativeDir: string): string[];
  write(root: TransactionRoot, relativePath: string, data: string | Uint8Array): void;
  remove(root: TransactionRoot, relativePath: string): void;
}

/** Content plus permission bits of one file; `data: null` means the file must be absent. */
interface FileState {
  data: string | null;
  mode: number;
}

interface StagedEntry extends FileState {
  root: TransactionRoot;
  path: string;
  before: FileState;
}

interface JournalOperation extends StagedEntry {
  beforeHash: string;
  afterHash: string;
}

interface Journal {
  version: 1;
  roots: { template: string; data: string };
  operations: JournalOperation[];
}

const MAX_OPERATIONS = 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 5000;
const JOURNAL_FILE = 'journal.sqlite';
const LOCK_FILE = 'lock.sqlite';

let running = false;

function fail(message: string, code: string | number = 409): never {
  throw Object.assign(new Error(message), { code });
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hash(data: string | null): string {
  return createHash('sha256').update(Buffer.from(data ?? '', 'base64')).digest('hex');
}

/** Absolute, normalized real directory whose whole ancestry is made of real directories. */
function checkDirectory(directory: string, state = false): string {
  if (!directory || !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory === path.parse(directory).root) {
    fail('目录必须是绝对、规范化的非根路径');
  }
  let current = path.parse(directory).root;
  for (const part of directory.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`不安全的目录：${current}`);
    // A sticky world-writable ancestor (such as /tmp) cannot be used to replace our private
    // folder, so only a non-sticky world-writable ancestor is refused here. A group-writable
    // ancestor is common on development machines (umask 002) and is accepted.
    if (state && (stat.mode & 0o002) && !(stat.mode & 0o1000)) fail(`状态目录的上级目录不可由他人写入：${current}`);
  }
  if (state) {
    const stat = fs.lstatSync(directory);
    if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      fail('状态目录必须属于当前用户且不对其他用户开放');
    }
  }
  return directory;
}

function checkStateFiles(directory: string): void {
  for (const name of fs.readdirSync(directory)) {
    if (!/^(?:lock|journal)\.sqlite(?:-journal)?$/.test(name)) fail(`状态目录中存在未知文件：${name}`);
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
      fail(`不安全的状态文件：${name}`);
    }
  }
}

function relativeParts(relative: string): string[] {
  if (typeof relative !== 'string' || !relative || relative.length > 4096 || relative.includes('\0') ||
      path.isAbsolute(relative) || relative.includes('\\')) {
    fail('不安全的相对路径');
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) fail('不安全的相对路径');
  return parts;
}

/**
 * Resolve a staged path, refusing symlinks and hard links anywhere on the way. The leaf may be
 * missing when `allowMissingLeaf` is set; every parent directory must already exist.
 */
function resolve(root: string, relative: string, allowMissingLeaf = true, kind: 'file' | 'dir' = 'file'): string {
  const parts = relativeParts(relative);
  let target = root;
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingLeaf && index === parts.length - 1) return target;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`不安全的路径：${target}`);
    if (index < parts.length - 1 || kind === 'dir') {
      if (!stat.isDirectory()) fail(`不安全的路径：${target}`);
    } else if (!stat.isFile() || stat.nlink !== 1) {
      fail(`不安全的文件：${target}`);
    }
  }
  return target;
}

function readState(file: string): FileState | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1) fail(`不安全的文件：${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) fail(`文件已变化：${file}`);
    return { data: fs.readFileSync(fd).toString('base64'), mode: opened.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

function sameState(left: FileState, right: FileState): boolean {
  return left.data === right.data && (left.data === null || left.mode === right.mode);
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Make `after` the on-disk state of one file. */
function applyState(root: string, operation: { path: string; data: string | null; mode: number }): void {
  const target = resolve(root, operation.path, true);
  const directory = path.dirname(target);
  if (operation.data === null) {
    try { fs.unlinkSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    syncDirectory(directory);
    return;
  }
  const content = Buffer.from(operation.data, 'base64');
  const temp = path.join(directory, `.doclight-tx-${process.pid}-${randomBytes(12).toString('hex')}`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, operation.mode || 0o644);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    // The leaf may have appeared between staging and applying; never replace a foreign file.
    resolve(root, operation.path, true);
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* the temporary file is already gone */ }
    throw error;
  }
  syncDirectory(directory);
}

function validateJournal(value: unknown, roots: { template: string; data: string }): Journal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('事务日志无效');
  const record = value as Partial<Journal>;
  if (record.version !== 1 || !record.roots || !Array.isArray(record.operations)) fail('事务日志无效');
  if (record.roots.template !== roots.template || record.roots.data !== roots.data) {
    fail('事务日志属于其他目录配置，拒绝自动恢复');
  }
  if (!record.operations.length || record.operations.length > MAX_OPERATIONS) fail('事务日志无效');
  let total = 0;
  const operations = record.operations.map(item => {
    if (!item || typeof item !== 'object') fail('事务日志无效');
    if (item.root !== 'template' && item.root !== 'data') fail('事务日志无效');
    relativeParts(item.path);
    for (const state of [item.before, { data: item.data, mode: item.mode }]) {
      if (!state || typeof state !== 'object') fail('事务日志无效');
      if (!(state.data === null || typeof state.data === 'string')) fail('事务日志无效');
      if (typeof state.data === 'string') {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(state.data)) fail('事务日志无效');
        total += Buffer.byteLength(state.data, 'base64');
      }
      if (!Number.isInteger(state.mode) || state.mode < 0 || state.mode > 0o777) fail('事务日志无效');
    }
    if (item.beforeHash !== hash(item.before.data) || item.afterHash !== hash(item.data)) fail('事务日志校验失败');
    return item;
  });
  if (total > MAX_TOTAL_BYTES) fail('事务日志过大');
  return { version: 1, roots: { template: roots.template, data: roots.data }, operations };
}

function recover(journal: Database.Database, roots: { template: string; data: string }): void {
  const row = journal.prepare('SELECT payload FROM redo WHERE id = 1').get() as { payload: string } | undefined;
  if (!row) return;
  if (typeof row.payload !== 'string' || row.payload.length > MAX_TOTAL_BYTES * 2) fail('事务日志过大');
  const record = validateJournal(JSON.parse(row.payload), roots);
  const pending: Array<{ root: string; operation: { path: string; data: string | null; mode: number } }> = [];
  for (const operation of record.operations) {
    const root = roots[operation.root];
    const current = readState(resolve(root, operation.path, true));
    const after: FileState = { data: operation.data, mode: operation.mode };
    if (current && sameState(current, after)) continue;
    if (current === null ? operation.before.data !== null : !sameState(current, operation.before)) {
      fail('结构事务恢复到未知状态，已停止自动恢复，请人工检查模板文件');
    }
    pending.push({ root, operation: { path: operation.path, data: operation.data, mode: operation.mode } });
  }
  for (const item of pending) applyState(item.root, item.operation);
  journal.prepare('DELETE FROM redo WHERE id = 1').run();
}

/**
 * Apply all file changes of `callback` as one recoverable unit. The callback must be synchronous:
 * it runs while the cross-process lock is held and nothing else in this process can interleave.
 */
export function runTemplateTransaction<T>(
  options: TemplateTransactionOptions,
  callback: (transaction: TemplateTransaction) => T,
): T {
  if (running) fail('不支持嵌套的模板事务');
  const state = checkDirectory(options.stateDir, true);
  const roots = { template: checkDirectory(options.templateDir), data: checkDirectory(options.dataDir) };
  for (const root of Object.values(roots)) {
    if (within(root, state) || within(state, root)) fail('事务目录不能与模板或数据目录重叠');
  }
  if (within(roots.template, roots.data) || within(roots.data, roots.template)) fail('模板与数据目录不能重叠');
  checkStateFiles(state);
  for (const name of [LOCK_FILE, JOURNAL_FILE]) {
    const file = path.join(state, name);
    const handle = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail('状态数据库不安全');
    } finally { fs.closeSync(handle); }
  }
  const lock = new Database(path.join(state, LOCK_FILE), { timeout: LOCK_TIMEOUT_MS });
  const journal = new Database(path.join(state, JOURNAL_FILE), { timeout: LOCK_TIMEOUT_MS });
  let locked = false;
  running = true;
  try {
    lock.pragma('busy_timeout = ' + LOCK_TIMEOUT_MS);
    lock.exec('BEGIN IMMEDIATE');
    locked = true;
    journal.pragma('synchronous = FULL');
    journal.exec('CREATE TABLE IF NOT EXISTS redo (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
    recover(journal, roots);
    const staged = new Map<string, StagedEntry>();
    const locate = (root: TransactionRoot, relative: string): { rootDir: string; absolute: string } => {
      if (root !== 'template' && root !== 'data') fail('事务根无效');
      const rootDir = roots[root];
      return { rootDir, absolute: resolve(rootDir, relative) };
    };
    const currentState = (root: TransactionRoot, relative: string): FileState | null => {
      const { absolute } = locate(root, relative);
      const entry = staged.get(absolute);
      return entry ? { data: entry.data, mode: entry.mode } : readState(absolute);
    };
    const stage = (root: TransactionRoot, relative: string, next: { data: string | null; mode: number }): void => {
      const { absolute } = locate(root, relative);
      const entry = staged.get(absolute);
      const before = entry ? entry.before : readState(absolute) ?? { data: null, mode: 0 };
      staged.set(absolute, { root, path: relative, data: next.data, mode: next.mode, before });
    };
    const transaction: TemplateTransaction = {
      read(root, relative) {
        const state = currentState(root, relative);
        if (!state || state.data === null) fail('文件不存在', 'ENOENT');
        return Buffer.from(state.data, 'base64');
      },
      exists(root, relative) {
        const state = currentState(root, relative);
        return state !== null && state.data !== null;
      },
      list(root, relativeDir) {
        if (root !== 'template' && root !== 'data') fail('事务根无效');
        const rootDir = roots[root];
        let base = rootDir;
        if (relativeDir) {
          for (const part of relativeParts(relativeDir)) {
            base = path.join(base, part);
            const stat = fs.lstatSync(base);
            if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`不安全的目录：${base}`);
          }
        }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(base, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        const names = new Set(entries
          .filter(entry => entry.isFile() || entry.isSymbolicLink())
          .map(entry => entry.name));
        const resolvedBase = path.resolve(base);
        for (const [absolute, entry] of staged) {
          if (path.dirname(absolute) !== resolvedBase) continue;
          const name = path.basename(absolute);
          if (entry.data === null) names.delete(name); else names.add(name);
        }
        return [...names].sort();
      },
      write(root, relative, data) {
        const buffer = Buffer.from(data);
        if (buffer.length > MAX_TOTAL_BYTES) fail('单次事务写入过大');
        const current = currentState(root, relative);
        const encoded = buffer.toString('base64');
        if (current && current.data === encoded) return;
        stage(root, relative, { data: encoded, mode: current && current.data !== null ? current.mode : 0o644 });
      },
      remove(root, relative) {
        const current = currentState(root, relative);
        if (!current) return;
        stage(root, relative, { data: null, mode: current.mode });
      },
    };
    const result = callback(transaction);
    if (staged.size > MAX_OPERATIONS) fail('一次结构操作涉及的文件过多');
    const operations: JournalOperation[] = [];
    let total = 0;
    for (const [absolute, entry] of staged) {
      const rootDir = roots[entry.root];
      total += Buffer.byteLength(entry.data ?? '', 'base64') + Buffer.byteLength(entry.before.data ?? '', 'base64');
      if (total > MAX_TOTAL_BYTES) fail('一次结构操作的数据过多');
      operations.push({
        ...entry,
        path: path.relative(rootDir, absolute).split(path.sep).join('/'),
        beforeHash: hash(entry.before.data),
        afterHash: hash(entry.data),
      });
    }
    if (operations.length) {
      const payload: Journal = { version: 1, roots: { template: roots.template, data: roots.data }, operations };
      journal.prepare('INSERT INTO redo (id, payload) VALUES (1, ?)').run(JSON.stringify(payload));
      syncDirectory(state);
      for (const operation of operations) {
        applyState(roots[operation.root], { path: operation.path, data: operation.data, mode: operation.mode });
      }
      journal.prepare('DELETE FROM redo WHERE id = 1').run();
    }
    return result;
  } finally {
    running = false;
    journal.close();
    if (locked) { try { lock.exec('ROLLBACK'); } catch { /* released with the handle */ } }
    lock.close();
  }
}

/** Replay a journal left behind by an interrupted structural edit, if one exists. */
export function recoverTemplateTransaction(options: TemplateTransactionOptions): void {
  runTemplateTransaction(options, () => undefined);
}
