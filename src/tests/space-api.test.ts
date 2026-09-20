/*
 * Space REST API regression tests.
 *
 * The space slug became editable after pages could already be renamed by slug. This
 * suite drives a real server process so the request handling, the reference rewrites
 * and the on-disk state are all covered: every field must be validated *before*
 * anything is applied, otherwise a rejected request leaves the tree half-renamed
 * while the JSON file on disk still holds the old slug.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as YAML from 'yaml';

const root = path.resolve(__dirname, '../..');
const serverEntry = path.join(root, 'dist', 'server.js');

interface StartedServer {
  port: number;
  dataDir: string;
  stop: () => void;
}

/** Boot dist/server.js on a scraped port and resolve once it is listening. */
function startServer(): Promise<StartedServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-space-test-'));
  // Keep the child isolated from any configuration in the developer's environment or a
  // doclight.toml in the repository root: an inherited port or strict mode would change
  // which port the server picks and break the scraped-port assumptions below.
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['PORT', 'DOCLIGHT_HOST', 'DOCLIGHT_STRICT_PORT', 'DOCLIGHT_DATA_DIR']) delete baseEnv[key];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...baseEnv,
      PORT: '4730',
      DOCLIGHT_DATA_DIR: dataDir,
      DOCLIGHT_CONFIG: path.join(dataDir, 'absent.toml'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('server did not start in time:\n' + output));
    }, 15000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        port: Number(match[1]),
        dataDir,
        stop: () => {
          child.kill();
          try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
        },
      });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}:\n${output}`));
    });
  });
}

interface ApiResult {
  status: number;
  body: any;
}

async function main(): Promise<void> {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  let cookie = '';
  const api = async (endpoint: string, opts: RequestInit = {}): Promise<ApiResult> => {
    const res = await fetch(base + '/api/' + endpoint, {
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...opts,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const readTree = async () => (await api('tree')).body;
  // Pages are stored as individual Markdown files; a rename must be reflected in each file's
  // front matter (the space lives there, not in a central index).
  const readDisk = () => ({
    pages: fs.readdirSync(path.join(server.dataDir, 'pages'))
      .filter(name => name.endsWith('.md'))
      .map(name => {
        const raw = fs.readFileSync(path.join(server.dataDir, 'pages', name), 'utf8');
        return YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || '') as Record<string, unknown>;
      }),
  });

  try {
    /* ---- Authenticate: writes require a session ---- */
    const state = (await api('auth/state')).body;
    const ks = pbkdf2Sync('pw123456', Buffer.from(state.salt, 'hex'), state.iters, 32, 'sha256').toString('hex');
    const setup = await api('auth/setup', { method: 'POST', body: JSON.stringify({ user: 'tester', ks }) });
    assert.equal(setup.status, 200, 'account setup should succeed');
    assert.ok(cookie, 'setup should issue a session cookie');

    /* ---- Seed data ---- */
    const tree = await readTree();
    assert.equal(tree.spaces[0].slug, 'default', 'seed space should be default');
    assert.ok(tree.pages.every((p: any) => p.space === 'default'), 'seed pages should belong to default');

    /* ---- Validation rejects without touching anything ---- */
    const reserved = await api('spaces/default', { method: 'PUT', body: JSON.stringify({ slug: 'spaces' }) });
    assert.equal(reserved.status, 400, 'reserved keyword should be rejected');
    const taken = await api('spaces/default', { method: 'PUT', body: JSON.stringify({ slug: 'welcome' }) });
    assert.equal(taken.status, 400, 'slug colliding with a page should be rejected');
    const invalid = await api('spaces/default', { method: 'PUT', body: JSON.stringify({ slug: 'Bad Slug!' }) });
    assert.equal(invalid.status, 400, 'malformed slug should be rejected');
    assert.equal((await readTree()).spaces[0].slug, 'default', 'rejections must not rename the space');

    /* ---- A rejected field must not leave a half-applied rename ---- */
    const partiallyBad = await api('spaces/default', {
      method: 'PUT',
      body: JSON.stringify({ slug: 'renamed_space', title: '   ' }),
    });
    assert.equal(partiallyBad.status, 400, 'invalid title should be rejected');
    const afterReject = await readTree();
    assert.equal(afterReject.spaces[0].slug, 'default', 'slug must stay untouched when another field is invalid');
    assert.ok(afterReject.pages.every((p: any) => p.space === 'default'), 'page references must stay untouched');
    assert.ok(readDisk().pages.every((p: any) => p.space === 'default'), 'disk must match the untouched tree');

    /* ---- Valid updates apply together and carry the references ---- */
    const renamed = await api('spaces/default', {
      method: 'PUT',
      body: JSON.stringify({ slug: 'renamed_space', title: '改名了' }),
    });
    assert.equal(renamed.status, 200, 'valid combined update should succeed');
    assert.equal(renamed.body.slug, 'renamed_space', 'response should carry the new slug');
    assert.equal(renamed.body.title, '改名了', 'response should carry the new title');
    const afterRename = await readTree();
    assert.ok(afterRename.pages.every((p: any) => p.space === 'renamed_space'), 'pages must re-point to the new space');
    assert.ok(readDisk().pages.every((p: any) => p.space === 'renamed_space'), 'disk must match the renamed tree');

    /* ---- The old slug stops resolving ---- */
    const gone = await api('spaces/default', { method: 'PUT', body: JSON.stringify({ title: 'x' }) });
    assert.equal(gone.status, 404, 'old slug should no longer resolve');

    /* ---- Page delete removes each file (the store only unlinks declared slugs) ---- */
    const pageFiles = () => fs.readdirSync(path.join(server.dataDir, 'pages')).filter(n => n.endsWith('.md'));
    const created = await api('pages', { method: 'POST', body: JSON.stringify({ title: '待删页', space: 'renamed_space' }) });
    assert.equal(created.status, 201, 'page creation should succeed');
    const doomedSlug = created.body.slug;
    assert.ok(pageFiles().includes(`${doomedSlug}.md`), '新建页面应落成 .md 文件');
    const removePage = await api('pages/' + doomedSlug, { method: 'DELETE' });
    assert.equal(removePage.status, 200, 'page deletion should succeed');
    assert.ok(!pageFiles().includes(`${doomedSlug}.md`), '删除页面应同时移除对应 .md 文件');
    assert.ok((await readTree()).pages.every((p: any) => p.slug !== doomedSlug), '删除后树中不应再有该页面');

    /* ---- A slug rename moves the file rather than leaving an orphan ---- */
    const renamedPage = await api('pages/welcome', { method: 'PUT', body: JSON.stringify({ slug: 'welcome_renamed' }) });
    assert.equal(renamedPage.status, 200, 'page slug rename should succeed');
    assert.ok(!pageFiles().includes('welcome.md'), '改名后旧文件应被移除');
    assert.ok(pageFiles().includes('welcome_renamed.md'), '改名后应产生新文件');

    /* ---- Deleting a space removes all of its page files ---- */
    const spaceFilesBefore = pageFiles();
    assert.ok(spaceFilesBefore.length > 0, '删除空间前应仍有页面文件');
    const removedSpace = await api('spaces/renamed_space', { method: 'DELETE' });
    assert.equal(removedSpace.status, 200, 'space deletion should succeed');
    assert.ok(pageFiles().length === 0, '空间内全部页面文件应被移除');
    const spaceIndex = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'spaces.json'), 'utf8'));
    assert.equal(spaceIndex.spaces.length, 0, 'spaces.json 应不再包含已删除空间');

    /* ---- A failed write returns 500 and must not take the process down ---- */
    // `fs` errors carry a *string* code (`EISDIR` here) while the deliberate HTTP failures carry a
    // number (413, 400). The catch handed either to `writeHead` as the status, so a string code
    // threw ERR_HTTP_INVALID_STATUS_CODE — from inside a `.catch`, which escaped as an unhandled
    // rejection and killed the server. Any failed save (a read-only mount, a full disk) therefore
    // took the whole site offline instead of returning an error.
    const probe = await api('spaces', { method: 'POST', body: JSON.stringify({ title: '写入失败探测' }) });
    assert.equal(probe.status, 201, '前置：探测空间应创建成功');
    const probeSlug = probe.body.slug;

    // A directory where the atomic write wants its temp file: every subsequent write fails EISDIR.
    const blocker = path.join(server.dataDir, 'spaces.json.tmp');
    fs.mkdirSync(blocker);
    try {
      const failed = await api('spaces/' + probeSlug, {
        method: 'PUT',
        body: JSON.stringify({ sort: 'title_asc' }),
      });
      assert.equal(failed.status, 500, '写入失败应返回 500，而不是把 errno 字符串当状态码');
      assert.equal(failed.body.error, '服务器内部错误', '500 不应把内部错误细节透给调用方');
      assert.ok(!String(failed.body.error).includes(server.dataDir), '500 消息不应泄露文件系统路径');

      // The decisive assertion: the process survived. Before the fix it had already exited and this
      // request could not connect at all.
      const alive = await api('tree');
      assert.equal(alive.status, 200, '单次写入失败不得让服务进程退出');
    } finally {
      fs.rmdirSync(blocker);
    }

    // The store recovers once the obstruction is gone, and nothing was left half-applied.
    const recovered = await api('spaces/' + probeSlug, {
      method: 'PUT',
      body: JSON.stringify({ sort: 'title_asc' }),
    });
    assert.equal(recovered.status, 200, '阻塞移除后写入应恢复正常');
    assert.equal(recovered.body.sort, 'title_asc', '恢复后的写入应真正落盘');
    await api('spaces/' + probeSlug, { method: 'DELETE' });

    console.log('space API assertions passed');
  } finally {
    server.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
