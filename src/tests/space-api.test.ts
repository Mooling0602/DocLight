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

    console.log('space API assertions passed');
  } finally {
    server.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
