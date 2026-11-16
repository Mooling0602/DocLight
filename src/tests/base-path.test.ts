import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

async function run(basePath?: string): Promise<void> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-base-path-'));
  fs.mkdirSync(path.join(sandbox, 'dist'));
  for (const name of fs.readdirSync(path.join(root, 'dist'))) {
    if (name.endsWith('.js')) fs.copyFileSync(path.join(root, 'dist', name), path.join(sandbox, 'dist', name));
  }
  fs.cpSync(path.join(root, 'public'), path.join(sandbox, 'public'), { recursive: true });
  fs.cpSync(path.join(root, 'template'), path.join(sandbox, 'template'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: '4700', DOCLIGHT_STRICT_PORT: '', DOCLIGHT_CONFIG: path.join(sandbox, 'absent.toml'), DOCLIGHT_DATA_DIR: path.join(sandbox, 'data') };
  if (basePath === undefined) delete env.DOCLIGHT_BASE_PATH;
  else env.DOCLIGHT_BASE_PATH = basePath;
  const child = spawn(process.execPath, [path.join(sandbox, 'dist/server.js')], {
    cwd: sandbox,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timed out: ' + output)), 15000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    });
    const request = (url: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${url}`, init);
    if (basePath === undefined) {
      const shell = async (url: string, prefix: string, headers?: Record<string, string>) => {
        const html = await (await request(url, { headers })).text();
        assert.ok(html.includes(`<meta name="doclight-base-path" content="${prefix}">`), url);
        assert.ok(html.includes(`src="${prefix}/app.js"`), url);
      };
      await shell('/editor', '/editor');
      await shell('/editor/?q=1', '/editor');
      await shell('/', '', { 'x-forwarded-prefix': '/evil', 'x-forwarded-uri': '/evil/' });
      await shell('/other/', '/other');
      await shell('/editor/', '/editor');
      await shell('/unknown/deep', '');
      await shell('/bad%22/api/auth/state', '');
      assert.match((await request('/api/auth/state', { headers: { 'x-forwarded-prefix': '/evil' } })).headers.get('content-type') || '', /json/);
      assert.match((await request('/editor/app.js')).headers.get('content-type') || '', /javascript/);
      assert.match((await request('/one/two/style.css')).headers.get('content-type') || '', /text\/css/);
      assert.equal((await (await request('/editor/api/auth/state?x=1')).json() as { mode: string }).mode, 'setup');
      const setup = await request('/editor/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'test', ks: 'a'.repeat(64) }) });
      const cookie = setup.headers.get('set-cookie') || '';
      assert.match(cookie, /; Path=\/editor;/);
      const token = cookie.split(';')[0];
      const headers = { 'content-type': 'application/json', cookie: token };
      const createSpace = await request('/editor/api/spaces', { method: 'POST', headers, body: JSON.stringify({ title: 'Editor' }) });
      assert.equal(createSpace.status, 201);
      const createPage = await request('/api/pages', { method: 'POST', headers, body: JSON.stringify({ title: 'Page', space: 'editor' }) });
      assert.equal(createPage.status, 201);
      await shell('/editor/', ''); // Existing space beats the mount-root heuristic.
      await shell('/editor/page?x=1', '');
      await shell('/page/', '');
      await shell('/mount/editor/page?x=1', '/mount');
      await shell('/mount/page', '/mount');
      await shell('/editor/api/auth/state', ''); // Root space is never shadowed.
      await shell('/x/api/y/api/state', ''); // Multiple API boundaries are ambiguous.
      const logout = await request('/mount/api/auth/logout', { method: 'POST', headers: { cookie: token } });
      assert.match(logout.headers.get('set-cookie') || '', /; Path=\/mount; Max-Age=0/);
      return;
    }
    const prefix = basePath.replace(/\/$/, '');
    for (const route of prefix ? [prefix, prefix + '/', prefix + '/deep/link', '/', '/deep/link'] : ['/', '/deep/link']) {
      const html = await (await request(route)).text();
      assert.ok(html.includes(`<meta name="doclight-base-path" content="${prefix}">`), route);
      assert.ok(html.includes(`href="${prefix}/style.css?`), route);
      assert.ok(html.includes(`src="${prefix}/app.js"`), route);
      assert.ok(html.includes(`class="brand" href="${prefix}/"`), route);
    }
    if (!prefix) {
      const html = await (await request('/editor/?q=1')).text();
      assert.ok(html.includes('<meta name="doclight-base-path" content="">'));
    }
    for (const p of prefix ? [prefix, ''] : ['']) {
      for (const asset of ['/style.css', '/app.js']) {
        const res = await request(p + asset);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', asset.endsWith('.css') ? /text\/css/ : /javascript/);
      }
      const state = await request(p + '/api/auth/state');
      assert.equal((await state.json() as { mode: string }).mode, 'setup');
      assert.equal((await request(p + '/api/pages', { method: 'POST' })).status, 401);
    }
    if (prefix) {
      const unrelated = await request(prefix + 'x/api/auth/state');
      assert.match(unrelated.headers.get('content-type') || '', /text\/html/);
    }
    const setup = await request(prefix + '/api/auth/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'test', ks: 'a'.repeat(64) }),
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie') || '';
    assert.match(cookie, new RegExp(`; Path=${prefix || '/'};`));
    const token = cookie.split(';')[0];
    const state = await request('/api/auth/state', { headers: { cookie: token } });
    assert.equal((await state.json() as { authed: boolean }).authed, true);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie: token } });
    assert.match(logout.headers.get('set-cookie') || '', new RegExp(`; Path=${prefix || '/'}; Max-Age=0`));
    const after = await request(prefix + '/api/auth/state', { headers: { cookie: token } });
    assert.equal((await after.json() as { authed: boolean }).authed, false);
  } finally {
    child.kill();
    await new Promise<void>(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve()));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await run();
  await run('');
  await run('/');
  await run('/editor/');
  console.log('base path HTTP assertions passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
