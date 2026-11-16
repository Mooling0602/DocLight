import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { runTemplateTransaction, recoverTemplateTransaction } from '../template-transaction';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-tx-'));
const template = path.join(base, 'template');
const data = path.join(base, 'data');
const state = path.join(base, 'state');
const options = { templateDir: template, dataDir: data, stateDir: state };
const at = (root: string, relative: string) => path.join(root, relative);

function setup(): void {
  for (const dir of [template, data, state]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(at(template, 'pages'), { mode: 0o700 });
  fs.writeFileSync(at(template, 'pages/a.md'), 'a-before');
  fs.writeFileSync(at(template, 'pages/b.md'), 'b-before');
  fs.writeFileSync(at(data, 'c.md'), 'c-before');
}

function writeJournal(file: string, payload: unknown): void {
  const journal = new Database(file);
  try {
    journal.exec('CREATE TABLE IF NOT EXISTS redo (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
    journal.prepare('INSERT OR REPLACE INTO redo (id, payload) VALUES (1, ?)').run(JSON.stringify(payload));
  } finally { journal.close(); }
}

async function main(): Promise<void> {
  try {
    setup();
    // Staged read-your-writes, then a real write once the callback returns true.
    const readBack = runTemplateTransaction(options, tx => {
      tx.write('template', 'pages/a.md', 'a-after');
      assert.equal(tx.read('template', 'pages/a.md').toString(), 'a-after');
      assert.equal(tx.exists('template', 'pages/missing.md'), false);
      return tx.read('data', 'c.md').toString();
    });
    assert.equal(readBack, 'c-before');
    assert.equal(fs.readFileSync(at(template, 'pages/a.md'), 'utf8'), 'a-after');
    // Removing a staged file is visible to later reads in the same transaction.
    runTemplateTransaction(options, tx => {
      tx.remove('template', 'pages/b.md');
      assert.equal(tx.exists('template', 'pages/b.md'), false);
      assert.deepEqual(tx.list('template', 'pages'), ['a.md']);
    });
    assert.equal(fs.existsSync(at(template, 'pages/b.md')), false);
    // A throwing callback commits nothing.
    assert.throws(() => runTemplateTransaction(options, tx => { tx.write('data', 'c.md', 'never'); throw new Error('abort'); }), /abort/);
    assert.equal(fs.readFileSync(at(data, 'c.md'), 'utf8'), 'c-before');
    // Permission bits of a replaced file are preserved.
    fs.chmodSync(at(data, 'c.md'), 0o640);
    runTemplateTransaction(options, tx => tx.write('data', 'c.md', 'c-after'));
    assert.equal(fs.statSync(at(data, 'c.md')).mode & 0o777, 0o640);
    // Path escapes, symlinks and hard links are refused.
    assert.throws(() => runTemplateTransaction(options, tx => tx.write('data', '../escape', 'x')), /不安全的相对路径/);
    assert.throws(() => runTemplateTransaction(options, tx => tx.read('data', '/etc/passwd')), /不安全的相对路径/);
    fs.symlinkSync(at(data, 'c.md'), at(template, 'link.md'));
    assert.throws(() => runTemplateTransaction(options, tx => tx.read('template', 'link.md')), /不安全的/);
    fs.unlinkSync(at(template, 'link.md'));
    fs.linkSync(at(data, 'c.md'), at(template, 'hard.md'));
    assert.throws(() => runTemplateTransaction(options, tx => tx.write('template', 'hard.md', 'x')), /不安全的/);
    fs.unlinkSync(at(template, 'hard.md'));
    // Nested transactions are a programming error, not a deadlock.
    assert.throws(() => runTemplateTransaction(options, () => runTemplateTransaction(options, () => undefined)), /嵌套/);
    // Overlapping roots and a filesystem root are refused before touching anything.
    assert.throws(() => runTemplateTransaction({ ...options, dataDir: path.join(template, 'inner') }, () => undefined));
    assert.throws(() => runTemplateTransaction({ ...options, templateDir: '/' }, () => undefined), /非根路径/);
    assert.throws(() => runTemplateTransaction({ ...options, stateDir: path.join(data, 'state') }, () => undefined));
    // A journal recorded for other roots is never replayed.
    const journalFile = at(state, 'journal.sqlite');
    writeJournal(journalFile, {
      version: 1,
      roots: { template: path.join(base, 'other-template'), data },
      operations: [],
    });
    assert.throws(() => recoverTemplateTransaction(options), /其他目录配置/);
    const journal = new Database(journalFile);
    journal.prepare('DELETE FROM redo WHERE id = 1').run();
    journal.close();
    // Simulate a crash between two file replacements: the journal survives and is replayed.
    fs.writeFileSync(at(template, 'pages/a.md'), 'a-before');
    const originalRename = fs.renameSync;
    let renames = 0;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = (...args: Parameters<typeof fs.renameSync>) => {
      if (++renames === 2) throw new Error('simulated crash');
      return originalRename(...args);
    };
    try {
      assert.throws(() => runTemplateTransaction(options, tx => {
        tx.write('template', 'pages/a.md', 'a-crash');
        tx.write('data', 'c.md', 'c-crash');
      }), /simulated crash/);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
    }
    const afterFirst = fs.readFileSync(at(template, 'pages/a.md'), 'utf8');
    assert.ok(afterFirst === 'a-before' || afterFirst === 'a-crash');
    recoverTemplateTransaction(options);
    assert.equal(fs.readFileSync(at(template, 'pages/a.md'), 'utf8'), 'a-crash');
    assert.equal(fs.readFileSync(at(data, 'c.md'), 'utf8'), 'c-crash');
    recoverTemplateTransaction(options);
    assert.equal(fs.readFileSync(at(data, 'c.md'), 'utf8'), 'c-crash');
    // Another process holding the SQLite lock excludes this one.
    const holder = spawn(process.execPath, ['-e', `
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db = new Database(${JSON.stringify(at(state, 'lock.sqlite'))});
      db.exec('BEGIN IMMEDIATE');
      console.log('held');
      setTimeout(() => process.exit(0), 60_000);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(holder.stdout!, 'data');
    const started = Date.now();
    assert.throws(() => runTemplateTransaction(options, () => undefined), /database is locked|SQLITE_BUSY|busy/i);
    assert.ok(Date.now() - started >= 4000, 'the lock wait is bounded but real');
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    runTemplateTransaction(options, () => undefined);
    console.log('template transaction tests passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
