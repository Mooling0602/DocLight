/* Integration tests for ordinary-space locking, using a real isolated server. */
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import * as http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-lock-test-'));
const password = 'pw123456';
let child: ChildProcess | undefined;
let base = '';
let cookie = '';

async function start(): Promise<void> {
  const env = { ...process.env };
  for (const key of ['PORT', 'DOCLIGHT_HOST', 'DOCLIGHT_STRICT_PORT', 'DOCLIGHT_DATA_DIR']) delete env[key];
  child = spawn(process.execPath, [path.join(root, 'dist/server.js')], {
    cwd: root,
    env: { ...env, PORT: '4730', DOCLIGHT_DATA_DIR: dataDir, DOCLIGHT_CONFIG: path.join(dataDir, 'absent.toml') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const processChild = child;
  base = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('server startup timed out: ' + output)), 15000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    processChild.stdout!.on('data', receive);
    processChild.stderr!.on('data', receive);
    processChild.once('error', error => { clearTimeout(timer); reject(error); });
    processChild.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${output}`)); });
  });
}

async function stop(): Promise<void> {
  const running = child;
  child = undefined;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  await new Promise<void>(resolve => { running.once('exit', () => resolve()); running.kill(); });
}

async function api(endpoint: string, method = 'GET', body?: unknown, authenticated = true): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authenticated && cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (authenticated && setCookie) cookie = setCookie.split(';')[0];
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function proof(pass = password): Promise<{ nonce: string; proof: string }> {
  const challenge = await api('auth/challenge');
  assert.equal(challenge.status, 200);
  const { nonce, salt, iters } = challenge.body;
  const key = pbkdf2Sync(pass, Buffer.from(salt, 'hex'), iters, 32, 'sha256');
  return { nonce, proof: createHmac('sha256', key).update(nonce).digest('hex') };
}

async function main(): Promise<void> {
  try {
    // Seed once so the restart below preserves the data and lock state under test.
    fs.cpSync(path.join(root, 'template'), dataDir, { recursive: true });
    await start();
    const state = (await api('auth/state')).body;
    const ks = pbkdf2Sync(password, Buffer.from(state.salt, 'hex'), state.iters, 32, 'sha256').toString('hex');
    assert.equal((await api('auth/setup', 'POST', { user: 'tester', ks })).status, 200);
    assert.ok(cookie);
    const created = await api('spaces', 'POST', { title: 'Lockable Space' });
    assert.equal(created.status, 201);
    const space = created.body.slug as string;
    const spacePath = `spaces/${space}`;
    const newPage = await api('pages', 'POST', { title: 'Locked Page', space });
    assert.equal(newPage.status, 201);
    const page = newPage.body.slug as string;
    const outsider = await api('pages', 'POST', { title: 'Outside Page', space: 'default' });
    assert.equal(outsider.status, 201);
    const outsidePage = outsider.body.slug as string;
    // Existing data can contain cross-space parent references after a page is moved.
    const crossChild = await api('pages', 'POST', { title: 'Cross Space Child', space: 'default', parent: outsidePage });
    assert.equal(crossChild.status, 201);
    assert.equal((await api(`pages/${crossChild.body.slug}`, 'PUT', { space })).status, 200);
    const lockedFile = path.join(dataDir, 'pages', `${page}.md`);
    fs.appendFileSync(lockedFile, '\n\n  \n');
    const lockedBytes = fs.readFileSync(lockedFile, 'utf8');

    // A write whose body arrives slowly must not commit a snapshot taken before the lock.
    let finishSlow!: () => void;
    let slowStarted!: () => void;
    const slowReady = new Promise<void>(resolve => { slowStarted = resolve; });
    const slowResult = new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/pages/${page}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.write('{"title":');
      req.on('socket', socket => socket.once('connect', () => slowStarted()));
      finishSlow = () => req.end('"Late write"}');
    });
    await slowReady;
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: true }, false)).status, 401);
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: true })).status, 200);
    finishSlow();
    assert.equal(await slowResult, 423, 'a slow write must observe the latest lock state');
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: false }, false)).status, 401);
    assert.equal((await api('tree', 'GET', undefined, false)).status, 200);
    assert.equal((await api(`pages/${page}`, 'GET', undefined, false)).status, 200);
    const before = (await api('tree')).body;
    assert.equal(before.spaces.find((s: any) => s.slug === space).locked, true);

    const blocked: Array<[string, string, unknown?]> = [
      [spacePath, 'PUT', { title: 'Changed', slug: 'changed_space' }],
      [spacePath, 'DELETE'],
      ['pages', 'POST', { title: 'Forbidden Page', space }],
      [`pages/${page}`, 'PUT', { title: 'Changed page', content: 'not saved' }],
      [`pages/${page}`, 'DELETE'],
      [`pages/${page}`, 'PUT', { space: 'default' }],
      [`pages/${outsidePage}`, 'PUT', { space }],
      [`pages/${outsidePage}`, 'PUT', { slug: 'renamed_parent' }],
      [`pages/${outsidePage}`, 'DELETE'],
      ['spaces/default', 'DELETE'],
    ];
    for (const [endpoint, method, body] of blocked) {
      assert.equal((await api(endpoint, method, body)).status, 423, `${method} ${endpoint} should be locked`);
    }
    const after = (await api('tree')).body;
    assert.deepEqual(after, before, 'rejected writes must not mutate tree');
    assert.equal((await api(`pages/${outsidePage}`, 'PUT', { title: 'Outside Still Writable' })).status, 200);
    assert.equal(fs.readFileSync(lockedFile, 'utf8'), lockedBytes, 'unrelated writes must not normalize locked page files');

    const wrong = await proof('wrong-password');
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: false, ...wrong })).status, 401);
    assert.notEqual((await api(`${spacePath}/lock`, 'POST', { locked: false, ...wrong })).status, 200, 'failed proof must not be replayable');
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: false })).status !== 200, true);
    assert.equal((await api(`pages/${page}`, 'PUT', { title: 'Still locked' })).status, 423);

    // A restart must retain the lock even though sessions and challenges are in memory.
    await stop();
    cookie = '';
    await start();
    assert.equal((await api('tree')).body.spaces.find((s: any) => s.slug === space).locked, true);
    const login = await proof();
    assert.equal((await api('auth/login', 'POST', login)).status, 200);
    assert.equal((await api(`pages/${page}`, 'DELETE')).status, 423);
    const unlockProof = await proof();
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: false, ...unlockProof })).status, 200);
    assert.notEqual((await api(`${spacePath}/lock`, 'POST', { locked: false, ...unlockProof })).status, 200, 'successful proof must not be replayable');
    assert.equal((await api(`pages/${page}`, 'PUT', { title: 'Unlocked' })).status, 200);
    assert.equal((await api(`pages/${page}`, 'PUT', { space: 'default' })).status, 200);
    assert.equal((await api(`pages/${page}`, 'PUT', { space })).status, 200);

    // Simultaneous use of one challenge may authorize at most one unlock.
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: true })).status, 200);
    const shared = await proof();
    const attempts = await Promise.all([
      api(`${spacePath}/lock`, 'POST', { locked: false, ...shared }),
      api(`${spacePath}/lock`, 'POST', { locked: false, ...shared }),
    ]);
    assert.equal(attempts.filter(r => r.status === 200).length, 1, 'one-shot nonce must survive concurrent requests');
    const extra = await api('pages', 'POST', { title: 'After Unlock', space });
    assert.equal(extra.status, 201);
    assert.equal((await api(`pages/${extra.body.slug}`, 'DELETE')).status, 200);
    assert.equal((await api(spacePath, 'PUT', { title: 'Unlocked Space' })).status, 200);
    assert.equal((await api(spacePath, 'DELETE')).status, 200);
    console.log('space lock integration assertions passed');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
