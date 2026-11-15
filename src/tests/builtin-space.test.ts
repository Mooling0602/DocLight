/* Integration coverage for the virtual built-in space, using an isolated release and data dir. */
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStore } from '../store.js';

const root = path.resolve(__dirname, '../..');
const builtIn = 'doclight-default';
const password = 'pw123456';

async function main(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-builtin-'));
  const release = path.join(temp, 'release');
  const dataDir = path.join(temp, 'data');
  let child: ChildProcess | undefined;
  let base = '';
  let cookie = '';
  const template = path.join(release, 'template');
  const pagesDir = path.join(dataDir, 'pages');

  async function start(): Promise<void> {
    const env = { ...process.env };
    for (const key of ['PORT', 'DOCLIGHT_HOST', 'DOCLIGHT_STRICT_PORT', 'DOCLIGHT_DATA_DIR']) delete env[key];
    child = spawn(process.execPath, [path.join(release, 'dist/server.js')], {
      cwd: release,
      env: { ...env, PORT: '4760', DOCLIGHT_DATA_DIR: dataDir, DOCLIGHT_CONFIG: path.join(temp, 'absent.toml') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const running = child;
    base = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => { running.kill(); reject(new Error('server startup timed out: ' + output)); }, 15000);
      const receive = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      };
      running.stdout!.on('data', receive);
      running.stderr!.on('data', receive);
      running.once('error', error => { clearTimeout(timer); reject(error); });
      running.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${output}`)); });
    });
  }

  async function stop(): Promise<void> {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    await new Promise<void>(resolve => { running.once('exit', () => resolve()); running.kill(); });
  }

  async function api(endpoint: string, method = 'GET', body?: unknown, auth = true): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}/api/${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (auth && setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  const disk = () => ({
    index: fs.readFileSync(path.join(dataDir, 'spaces.json'), 'utf8'),
    pages: fs.readdirSync(pagesDir).sort().map(name => [name, fs.readFileSync(path.join(pagesDir, name), 'utf8')]),
  });
  const assertVirtualNotPersisted = () => {
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'spaces.json'), 'utf8'));
    assert.ok(!index.spaces.some((space: any) => space.slug === builtIn), 'virtual space must not be persisted');
    assert.ok(!fs.readdirSync(pagesDir).some(name => name.startsWith(`${builtIn}-`)), 'virtual pages must not be persisted');
  };

  try {
    // Copy the release so the upgrade test can edit its template, not the checkout's template.
    fs.mkdirSync(release, { recursive: true });
    fs.cpSync(path.join(root, 'dist'), path.join(release, 'dist'), { recursive: true });
    fs.cpSync(path.join(root, 'template'), template, { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(release, 'node_modules'), 'dir');
    fs.mkdirSync(pagesDir, { recursive: true });
    const originalIndex = JSON.stringify({ version: 4, spaces: [{ slug: 'default', title: 'Old user space', desc: 'Keep me', home: 'welcome', createdAt: 1, updatedAt: 2 }] }, null, 2) + '\n';
    const oldBytes = '---\ntitle: My old welcome\nspace: default\nparent: null\ncreatedAt: 1\nupdatedAt: 2\n---\n\nMy edited content.\n';
    fs.writeFileSync(path.join(dataDir, 'spaces.json'), originalIndex);
    fs.writeFileSync(path.join(pagesDir, 'welcome.md'), oldBytes);
    // An old shipped guide was deleted by the user before the upgrade.
    assert.ok(!fs.existsSync(path.join(pagesDir, 'guide.md')));
    const source = readStore(template);
    const sourceSpace = source.spaces.find(s => s.slug === 'default');
    assert.ok(sourceSpace);
    const sourcePages = source.pages.filter(p => p.space === 'default');
    assert.ok(sourcePages.length > 0);

    await start();
    const treeResult = await api('tree', 'GET', undefined, false);
    assert.equal(treeResult.status, 200);
    const tree = treeResult.body;
    const virtual = tree.spaces.find((s: any) => s.slug === builtIn);
    assert.ok(virtual, 'upgraded site exposes a virtual built-in space');
    assert.equal(virtual.builtIn, true);
    assert.equal(virtual.locked, true);
    assert.equal(virtual.home, sourceSpace.home ? `${builtIn}-${sourceSpace.home}` : sourceSpace.home);
    assert.ok(tree.spaces.some((s: any) => s.slug === 'default' && s.title === 'Old user space'));
    assert.equal(fs.readFileSync(path.join(pagesDir, 'welcome.md'), 'utf8'), oldBytes, 'upgrade must preserve exact old page bytes');
    assert.equal(fs.readFileSync(path.join(dataDir, 'spaces.json'), 'utf8'), originalIndex, 'upgrade must preserve the old index');
    assert.ok(!fs.existsSync(path.join(pagesDir, 'guide.md')), 'upgrade must not resurrect a deleted user page');
    assertVirtualNotPersisted();

    const virtualPages = tree.pages.filter((p: any) => p.space === builtIn);
    assert.deepEqual(virtualPages.map((p: any) => p.slug).sort(), sourcePages.map(p => `${builtIn}-${p.slug}`).sort());
    for (const page of sourcePages) {
      const slug = `${builtIn}-${page.slug}`;
      const metadata = virtualPages.find((p: any) => p.slug === slug);
      assert.equal(metadata.parent, page.parent ? `${builtIn}-${page.parent}` : null);
      const served = await api(`pages/${slug}`, 'GET', undefined, false);
      assert.equal(served.status, 200, 'built-in pages must be publicly readable');
      assert.equal(served.body.content, page.content, 'content must come from the shipped template');
    }

    const state = (await api('auth/state')).body;
    const ks = pbkdf2Sync(password, Buffer.from(state.salt, 'hex'), state.iters, 32, 'sha256').toString('hex');
    assert.equal((await api('auth/setup', 'POST', { user: 'tester', ks })).status, 200);
    assert.ok(cookie);
    const created = await api('pages', 'POST', { title: 'Outside page', space: 'default' });
    assert.equal(created.status, 201);
    const outside = created.body.slug;
    const page = virtualPages[0].slug;
    const challenge = (await api('auth/challenge')).body;
    const key = pbkdf2Sync(password, Buffer.from(challenge.salt, 'hex'), challenge.iters, 32, 'sha256');
    const proof = { nonce: challenge.nonce, proof: createHmac('sha256', key).update(challenge.nonce).digest('hex') };
    const beforeTree = (await api('tree')).body;
    const beforeDisk = disk();
    const blocked: Array<[string, string, unknown?]> = [
      [`spaces/${builtIn}`, 'PUT', { title: 'Changed' }],
      [`spaces/${builtIn}`, 'PUT', { desc: 'Changed' }],
      [`spaces/${builtIn}`, 'PUT', { slug: 'renamed' }],
      [`spaces/${builtIn}`, 'PUT', { home: outside }],
      [`spaces/${builtIn}`, 'PUT', { sort: 'title_asc' }],
      [`spaces/${builtIn}`, 'DELETE'],
      [`spaces/${builtIn}/lock`, 'POST', { locked: false, ...proof }],
      ['pages', 'POST', { title: 'Intruder', space: builtIn }],
      [`pages/${page}`, 'PUT', { title: 'Changed' }],
      [`pages/${page}`, 'PUT', { content: 'Changed' }],
      [`pages/${page}`, 'PUT', { slug: 'renamed_page' }],
      [`pages/${page}`, 'PUT', { space: 'default' }],
      [`pages/${page}`, 'DELETE'],
      [`pages/${outside}`, 'PUT', { space: builtIn }],
    ];
    for (const [endpoint, method, body] of blocked) {
      const result = await api(endpoint, method, body);
      assert.equal(result.status, 423, `${method} ${endpoint} must be locked`);
    }
    assert.deepEqual((await api('tree')).body, beforeTree, 'rejected mutations must not alter the tree');
    assert.deepEqual(disk(), beforeDisk, 'rejected mutations must not alter the store');
    assert.equal((await api(`pages/${outside}`, 'PUT', { title: 'Ordinary edit' })).status, 200);
    assertVirtualNotPersisted();
    assert.deepEqual((await api('tree')).body.pages.filter((p: any) => p.space === builtIn), virtualPages, 'ordinary writes must not change virtual pages');
    assert.equal(fs.readFileSync(path.join(pagesDir, 'welcome.md'), 'utf8'), oldBytes);
    assert.ok(!fs.existsSync(path.join(pagesDir, 'guide.md')));

    // Simulate installing a new release with the same data, without mutating the actual checkout.
    await stop();
    const changed = sourcePages[0];
    const templatePage = path.join(template, 'pages', `${changed.slug}.md`);
    fs.appendFileSync(templatePage, '\n\nRelease update marker.\n');
    const updated = readStore(template).pages.find(p => p.slug === changed.slug)!;
    await start();
    const afterUpgrade = await api(`pages/${builtIn}-${changed.slug}`, 'GET', undefined, false);
    assert.equal(afterUpgrade.status, 200);
    assert.equal(afterUpgrade.body.content, updated.content, 'new release must serve updated template content');
    assert.match(afterUpgrade.body.content, /Release update marker\./);
    assert.equal(fs.readFileSync(path.join(pagesDir, 'welcome.md'), 'utf8'), oldBytes);
    assert.ok(!fs.existsSync(path.join(pagesDir, 'guide.md')));
    assertVirtualNotPersisted();
    // The old default remains an ordinary space and can be deleted after upgrading.
    cookie = '';
    const loginChallenge = (await api('auth/challenge')).body;
    const loginKey = pbkdf2Sync(password, Buffer.from(loginChallenge.salt, 'hex'), loginChallenge.iters, 32, 'sha256');
    const loginProof = createHmac('sha256', loginKey).update(loginChallenge.nonce).digest('hex');
    assert.equal((await api('auth/login', 'POST', { user: 'tester', nonce: loginChallenge.nonce, proof: loginProof })).status, 200);
    assert.equal((await api('spaces/default', 'DELETE')).status, 200, 'old default should be deletable');
    const afterDelete = (await api('tree')).body;
    assert.ok(!afterDelete.spaces.some((s: any) => s.slug === 'default'));
    assert.ok(afterDelete.spaces.some((s: any) => s.slug === builtIn));
    assert.equal((await api(`pages/${builtIn}-${changed.slug}`)).status, 200);
    // A manually introduced reserved space must never be silently hidden or overwritten.
    const conflictingIndex = JSON.stringify({ version: 4, spaces: [{ slug: builtIn, title: 'User data', desc: '', home: null, createdAt: 1, updatedAt: 1 }] }, null, 2) + '\n';
    fs.writeFileSync(path.join(dataDir, 'spaces.json'), conflictingIndex);
    assert.equal((await api('tree')).status, 500);
    assert.equal(fs.readFileSync(path.join(dataDir, 'spaces.json'), 'utf8'), conflictingIndex);
    console.log('built-in space integration assertions passed');
  } finally {
    await stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
