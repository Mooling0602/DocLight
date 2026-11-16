/* Isolated release integration coverage for developer-only template editing. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';

const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-dev-mode-'));
const release = path.join(temp, 'release');
const template = path.join(release, 'template');
const data = path.join(temp, 'data');
const file = path.join(template, 'pages', 'welcome.md');
const virtual = 'doclight-default-welcome';
let child: ChildProcess | undefined;
let base = '';
let cookie = '';
let warnings = '';

async function start(mode?: string, dataDir = data): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: '4870', DOCLIGHT_DATA_DIR: dataDir, DOCLIGHT_CONFIG: path.join(temp, 'absent.toml'), DOCLIGHT_HOST: '0.0.0.0' };
  delete env.DOCLIGHT_DEV_MODE;
  delete env.DOCLIGHT_BASE_PATH;
  if (mode !== undefined) env.DOCLIGHT_DEV_MODE = mode;
  child = spawn(process.execPath, [path.join(release, 'dist/server.js')], { cwd: release, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const running = child;
  warnings = '';
  running.stderr!.on('data', c => { warnings += String(c); });
  base = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${output}`)), 15000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    running.stdout!.on('data', receive);
    running.stderr!.on('data', receive);
    running.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    running.once('error', reject);
  });
}
async function stop(): Promise<void> {
  const running = child; child = undefined;
  if (running && running.exitCode === null && running.signalCode === null) await new Promise<void>(resolve => { running.once('exit', () => resolve()); running.kill(); });
}
async function api(endpoint: string, method = 'GET', body?: unknown, auth = true): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/${endpoint}`, { method, headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const set = res.headers.get('set-cookie');
  if (auth && set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json() };
}
async function login(): Promise<void> {
  const challenge = (await api('auth/challenge')).body;
  const proof = createHmac('sha256', Buffer.from('aa'.repeat(32), 'hex')).update(challenge.nonce).digest('hex');
  assert.equal((await api('auth/login', 'POST', { nonce: challenge.nonce, proof })).status, 200);
}
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [k, v] of Object.entries(snapshot(p))) out[`${entry.name}/${k}`] = v;
    else if (entry.isSymbolicLink()) out[entry.name] = `link:${fs.readlinkSync(p)}`;
    else out[entry.name] = fs.readFileSync(p, 'utf8');
  }
  return out;
}
async function main(): Promise<void> {
  try {
    fs.mkdirSync(release, { recursive: true });
    fs.cpSync(path.join(root, 'dist'), path.join(release, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(template, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(template, 'spaces.json'), JSON.stringify({ version: 4, spaces: [{ slug: 'default', title: 'Default', desc: '', home: 'welcome', createdAt: 1, updatedAt: 1 }] }));
    fs.writeFileSync(file, '---\ntitle: 欢迎使用 DocLight\nspace: default\nparent: null\ncreatedAt: 1\nupdatedAt: 1\n---\n\n# Welcome\n');
    fs.writeFileSync(path.join(template, 'pages', 'guide.md'), '---\ntitle: Guide\nspace: default\nparent: null\ncreatedAt: 1\nupdatedAt: 1\n---\n\n# Guide\n');
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(release, 'node_modules'), 'dir');
    const opts = { root: temp, configPath: path.join(temp, 'absent.toml') };
    for (const value of ['', 'false', '0', 'TRUE', 'yes', ' true ']) assert.equal(loadConfig({ ...opts, env: { DOCLIGHT_DEV_MODE: value } }).devMode, false);
    for (const value of ['true', '1']) assert.equal(loadConfig({ ...opts, env: { DOCLIGHT_DEV_MODE: value } }).devMode, true);
    await start();
    let space = (await api('tree')).body.spaces.find((s: any) => s.builtIn);
    assert.equal(space.locked, true); assert.equal(space.devEditable, undefined);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { title: 'x' }, false)).status, 401);
    assert.equal((await api('auth/setup', 'POST', { user: 'tester', ks: 'aa'.repeat(32) })).status, 200);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { title: 'x' })).status, 423);
    await stop(); cookie = '';
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, before.replace('title: 欢迎使用 DocLight', '# title comment\ntitle: 欢迎使用 DocLight # inline comment\nunknown: { nested: value } # keep'));
    await start('1');
    assert.match(warnings, /DOCLIGHT_DEV_MODE/);
    space = (await api('tree')).body.spaces.find((s: any) => s.builtIn);
    assert.equal(space.locked, true); assert.equal(space.devEditable, true);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { content: 'unauthorized' }, false)).status, 401);
    await login();
    const initialTemplate = snapshot(template); const initialData = snapshot(data);
    const blocked: Array<[string, string, unknown?]> = [
      [`pages/${virtual}`, 'PUT', { locked: false }],
      ['spaces/doclight-default/lock', 'POST', { locked: false }],
    ];
    // The source space slug is not a valid move target; only ordinary spaces are.
    assert.equal((await api(`pages/${virtual}`, 'PUT', { space: 'default' })).status, 404);
    for (const [endpoint, method, body] of blocked) assert.equal((await api(endpoint, method, body)).status, 423, `${method} ${endpoint}`);
    assert.deepEqual(snapshot(template), initialTemplate); assert.deepEqual(snapshot(data), initialData);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { parent: virtual })).status, 400);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { parent: 'missing' })).status, 400);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { parent: null })).status, 200);
    assert.equal((await api('pages/doclight-default-guide', 'PUT', { parent: virtual })).status, 200);
    assert.match(fs.readFileSync(path.join(template, 'pages', 'guide.md'), 'utf8'), /parent: "welcome"/);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { parent: 'doclight-default-guide' })).status, 400);
    assert.equal((await api('pages/doclight-default-guide', 'PUT', { parent: null })).status, 200);
    assert.deepEqual(snapshot(data), initialData);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { title: 'x'.repeat(121) })).status, 400);
    assert.equal((await api(`pages/${virtual}`, 'PUT', { content: 'x'.repeat(500 * 1024 + 1) })).status, 400);
    assert.deepEqual(snapshot(template), initialTemplate, 'oversized edits must not truncate source');
    const saved = await api(`pages/${virtual}`, 'PUT', { title: 'New title', content: '# New body\n\nHello' });
    assert.equal(saved.status, 200); assert.equal(saved.body.title, 'New title');
    assert.equal((await api(`pages/${virtual}`)).body.content, '# New body\n\nHello');
    const after = snapshot(template);
    for (const key of Object.keys(initialTemplate)) if (key !== 'pages/welcome.md') assert.equal(after[key], initialTemplate[key]);
    assert.match(after['pages/welcome.md'], /# title comment\ntitle: "New title" # inline comment\nunknown: \{ nested: value \} # keep/);
    assert.deepEqual(snapshot(data), initialData);
    await stop(); cookie = ''; await start('true');
    assert.equal((await api(`pages/${virtual}`)).body.title, 'New title');
    assert.equal((await api(`pages/${virtual}`)).body.content, '# New body\n\nHello');
    await login();
    const indexPath = path.join(template, 'spaces.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.extra = { preserve: true };
    index.spaces.find((s: any) => s.slug === 'default').extra = 'preserved';
    fs.writeFileSync(indexPath, JSON.stringify(index));
    const changedSpace = await api('spaces/doclight-default', 'PUT', { title: 'Developer docs', desc: 'Description', sort: 'title_asc' });
    assert.equal(changedSpace.status, 200);
    assert.equal(changedSpace.body.slug, 'doclight-default');
    assert.equal(changedSpace.body.title, 'Developer docs');
    const updatedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.deepEqual(updatedIndex.extra, { preserve: true });
    assert.equal(updatedIndex.spaces.find((s: any) => s.slug === 'default').extra, 'preserved');
    assert.deepEqual(snapshot(data), initialData);
    // The recommendation switch is a source edit like the sort key: it lands in template/spaces.json
    // and disabling it removes the key instead of pinning `false`.
    const templateSpace = () => JSON.parse(fs.readFileSync(indexPath, 'utf8')).spaces.find((s: any) => s.slug === 'default');
    assert.equal((await api('spaces/doclight-default', 'PUT', { recommend: true })).status, 200);
    assert.equal(templateSpace().recommend, true, '开启推荐应写入模板索引');
    assert.equal((await api('spaces/doclight-default', 'PUT', { recommend: 'yes' })).status, 400);
    assert.equal(templateSpace().recommend, true, '非法值不得改动模板');
    assert.equal((await api('spaces/doclight-default', 'PUT', { recommend: false })).status, 200);
    assert.equal('recommend' in templateSpace(), false, '关闭推荐应删除该键');
    // Manual ordering on the built-in space translates virtual page slugs to source file names.
    const manualTemplate = await api('spaces/doclight-default', 'PUT', { sort: 'manual' });
    assert.equal(manualTemplate.status, 200);
    assert.equal(manualTemplate.body.sort, 'manual');
    assert.ok(Array.isArray(manualTemplate.body.order) && manualTemplate.body.order.length > 0, '切换手动排序应写入种子顺序');
    const virtualPage = (source: string) => `doclight-default-${source}`;
    const reordered = await api('spaces/doclight-default', 'PUT', { order: [virtualPage('guide'), virtualPage('welcome')] });
    assert.equal(reordered.status, 200);
    assert.deepEqual(templateSpace().order, ['guide', 'welcome'], '模板索引应保存源文件 slug 顺序');
    assert.deepEqual(reordered.body.order, [virtualPage('guide'), virtualPage('welcome')], '响应应使用虚拟页面 slug');
    assert.equal((await api('spaces/doclight-default', 'PUT', { order: ['welcome'] })).status, 400, '非虚拟 slug 应拒绝');
    assert.equal((await api('spaces/doclight-default', 'PUT', { order: 'nope' })).status, 400, '非数组应拒绝');
    assert.deepEqual(templateSpace().order, ['guide', 'welcome'], '被拒绝的请求不得改动模板');
    assert.equal((await api('spaces/doclight-default', 'PUT', { slug: 'spaces' })).status, 400);
    const beforeReserved = snapshot(template);
    assert.equal((await api('spaces/doclight-default', 'PUT', { slug: 'api' })).status, 400);
    assert.deepEqual(snapshot(template), beforeReserved);
    const indexWithReserved = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    indexWithReserved.doclightVirtualSlug = 'api';
    fs.writeFileSync(indexPath, JSON.stringify(indexWithReserved));
    assert.equal((await api('tree')).body.spaces.some((s: any) => s.builtIn), false);
    assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).doclightVirtualSlug, 'api');
    fs.writeFileSync(indexPath, beforeReserved['spaces.json']);
    const mapped = await api('spaces/doclight-default', 'PUT', { slug: 'developer_docs' });
    assert.equal(mapped.status, 200); assert.equal(mapped.body.slug, 'developer_docs');
    let mappedTree = (await api('tree')).body;
    assert.equal(mappedTree.spaces.find((s: any) => s.builtIn).slug, 'developer_docs');
    assert.equal(mappedTree.pages.find((p: any) => p.slug === virtual).space, 'developer_docs');
    assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).spaces[0].slug, 'default');
    assert.deepEqual(snapshot(data), initialData);
    const ordinarySpace = await api('spaces', 'POST', { title: 'Ordinary' });
    assert.equal(ordinarySpace.status, 201);
    assert.equal((await api('spaces/developer_docs', 'PUT', { slug: ordinarySpace.body.slug })).status, 409);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'spaces.json'), 'utf8')).spaces.map((s: any) => s.slug), [ordinarySpace.body.slug]);
    assert.equal((await api(`spaces/${ordinarySpace.body.slug}`, 'DELETE')).status, 200);
    assert.deepEqual(snapshot(data), initialData);
    await stop(); cookie = ''; await start(); await login();
    mappedTree = (await api('tree')).body;
    assert.equal(mappedTree.spaces.find((s: any) => s.builtIn).slug, 'developer_docs');
    assert.equal((await api('spaces/developer_docs', 'PUT', { slug: 'blocked' })).status, 423);
    assert.equal((await api(`pages/${virtual}`, 'DELETE')).status, 423);
    await stop(); cookie = ''; await start('true'); await login();
    const reservedPage = path.join(data, 'pages', 'reserved_name.md');
    fs.symlinkSync(path.join(temp, 'external-reserved'), reservedPage);
    assert.equal((await api('spaces/developer_docs', 'PUT', { slug: 'reserved_name' })).status, 409);
    fs.unlinkSync(reservedPage);
    assert.equal((await api('spaces/developer_docs', 'PUT', { slug: 'doclight-default' })).status, 200);
    assert.deepEqual(snapshot(data), initialData);
    const created = await api('pages', 'POST', { title: 'Temporary page', space: 'doclight-default', parent: virtual });
    assert.equal(created.status, 201);
    assert.equal(created.body.slug, 'doclight-default-temporary_page');
    assert.equal(created.body.parent, virtual);
    assert.equal((await api('pages/doclight-default-temporary_page')).status, 200);
    const removable = await api('pages', 'POST', { title: 'Removable parent', space: 'doclight-default' });
    assert.equal(removable.status, 201);
    const removableChild = await api('pages', 'POST', { title: 'Removable child', space: 'doclight-default', parent: removable.body.slug });
    assert.equal(removableChild.status, 201);
    const removedTree = await api(`pages/${removable.body.slug}`, 'DELETE');
    assert.equal(removedTree.status, 200);
    assert.deepEqual(removedTree.body.removed.sort(), [removable.body.slug, removableChild.body.slug].sort());
    assert.equal((await api(`pages/${removableChild.body.slug}`)).status, 404);
    const malformed = path.join(template, 'pages', 'malformed.md');
    fs.writeFileSync(malformed, '---\nspace: [broken\n---\nbody\n');
    assert.equal((await api('pages/doclight-default-temporary_page', 'DELETE')).status, 409);
    fs.unlinkSync(malformed);
    assert.equal((await api('pages/doclight-default-temporary_page', 'DELETE')).status, 200);
    assert.equal((await api('pages/doclight-default-temporary_page')).status, 404);
    const external = path.join(temp, 'external.md');
    fs.writeFileSync(external, 'external content');
    const collision = path.join(template, 'pages', 'collision.md');
    fs.symlinkSync(external, collision);
    assert.equal((await api('pages', 'POST', { title: 'Collision', space: 'doclight-default' })).status, 409);
    assert.equal(fs.readFileSync(external, 'utf8'), 'external content');
    fs.unlinkSync(collision);
    assert.deepEqual(snapshot(data), initialData);
    const whitespace = '# Keep whitespace\n\nLine with spaces  \n\n';
    assert.equal((await api(`pages/${virtual}`, 'PUT', { content: whitespace })).status, 200);
    assert.equal((await api(`pages/${virtual}`)).body.content, whitespace, 'source content must retain trailing whitespace');
    const good = fs.readFileSync(file, 'utf8');
    for (const invalid of ['---\ntitle: [broken\n---\nbody', '---\ntitle: x\ntitle: y\n---\nbody', '---\ntitle: x\nbody', '---\ntitle: x\nspace: other\n---\nbody']) {
      fs.writeFileSync(file, invalid);
      assert.notEqual((await api(`pages/${virtual}`, 'PUT', { content: 'overwrite' })).status, 200);
      assert.equal(fs.readFileSync(file, 'utf8'), invalid);
    }
    for (const unsafe of [
      '---\ntitle: |\n  Old title\nspace: default\nparent: null\n---\nbody\n',
      '---\ntitle: >-\n  Old title\nspace: default\nparent: null\n---\nbody\n',
      '---\ntitle: &name old\nspace: default\nparent: *name\n---\nbody\n',
      '---\ntitle: old\nspace: default\nparent: null\nextra: { value: &ref yes, other: *ref }\n---\nbody\n',
    ]) {
      fs.writeFileSync(file, unsafe);
      assert.equal((await api(`pages/${virtual}`, 'PUT', { title: 'New' })).status, 400);
      assert.equal(fs.readFileSync(file, 'utf8'), unsafe);
    }
    const guideFile = path.join(template, 'pages', 'guide.md');
    const guideGood = fs.readFileSync(guideFile, 'utf8');
    const blockParent = guideGood.replace('parent: null', 'parent: |-\n  welcome');
    fs.writeFileSync(guideFile, blockParent);
    assert.equal((await api('pages/doclight-default-guide', 'PUT', { parent: null })).status, 400);
    assert.equal(fs.readFileSync(guideFile, 'utf8'), blockParent);
    fs.writeFileSync(guideFile, guideGood);
    fs.writeFileSync(file, good);
    const outside = path.join(temp, 'outside.md'); fs.writeFileSync(outside, good);
    fs.unlinkSync(file); fs.symlinkSync(outside, file);
    assert.notEqual((await api(`pages/${virtual}`, 'PUT', { content: 'overwrite' })).status, 200);
    assert.equal(fs.readFileSync(outside, 'utf8'), good);
    fs.unlinkSync(file); fs.writeFileSync(file, good);
    const pages = path.join(template, 'pages');
    const realPages = path.join(template, 'real-pages');
    fs.renameSync(pages, realPages); fs.symlinkSync(realPages, pages, 'dir');
    assert.notEqual((await api(`pages/${virtual}`, 'PUT', { content: 'overwrite' })).status, 200);
    assert.equal(fs.readFileSync(path.join(realPages, 'welcome.md'), 'utf8'), good);
    fs.unlinkSync(pages); fs.renameSync(realPages, pages);
    await stop(); cookie = '';
    const alias = path.join(temp, 'template-alias');
    fs.symlinkSync(template, alias, 'dir');
    const nested = path.join(template, 'nested-data');
    fs.mkdirSync(nested);
    for (const overlap of [template, alias, release, nested]) {
      fs.copyFileSync(path.join(data, 'auth.json'), path.join(overlap, 'auth.json'));
      await start('true', overlap);
      await login();
      const beforeOverlap = snapshot(template);
      assert.equal((await api(`pages/${virtual}`, 'PUT', { title: 'Blocked' })).status, 409);
      assert.equal((await api('spaces/doclight-default', 'PUT', { title: 'Blocked' })).status, 409);
      assert.equal((await api('pages', 'POST', { title: 'Blocked', space: 'doclight-default' })).status, 409);
      assert.equal((await api('pages/doclight-default-guide', 'DELETE')).status, 409);
      assert.deepEqual(snapshot(template), beforeOverlap);
      await stop(); cookie = '';
    }
    // Slug renames re-point direct children and never overwrite an existing source page.
    await start('true'); await login();
    const renameParent = await api('pages', 'POST', { title: 'Rename parent', space: 'doclight-default' });
    assert.equal(renameParent.status, 201);
    const renameChild = await api('pages', 'POST', { title: 'Rename child', space: 'doclight-default', parent: renameParent.body.slug });
    assert.equal(renameChild.status, 201);
    const renamedPage = await api(`pages/${renameParent.body.slug}`, 'PUT', { slug: 'renamed_parent' });
    assert.equal(renamedPage.status, 200);
    assert.equal(renamedPage.body.slug, 'doclight-default-renamed_parent');
    assert.equal((await api(`pages/${renameChild.body.slug}`)).body.parent, 'doclight-default-renamed_parent');
    assert.equal((await api(`pages/${renameParent.body.slug}`)).status, 404);
    assert.equal((await api(`pages/doclight-default-renamed_parent`, 'PUT', { slug: 'guide' })).status, 409);
    assert.equal((await api('pages/doclight-default-guide')).status, 200, 'a refused rename must not overwrite the target');
    const renamedRemoval = await api('pages/doclight-default-renamed_parent', 'DELETE');
    assert.equal(renamedRemoval.status, 200);
    assert.deepEqual(renamedRemoval.body.removed.sort(), ['doclight-default-renamed_parent', renameChild.body.slug].sort());
    // Cross-space moves rewrite the owning store in one transaction.
    const targetSpace = await api('spaces', 'POST', { title: 'Move target' });
    assert.equal(targetSpace.status, 201);
    const targetSlug = targetSpace.body.slug;
    assert.equal((await api('pages', 'POST', { title: 'Guide', space: targetSlug })).body.slug, 'guide');
    assert.equal((await api('pages/doclight-default-guide', 'PUT', { space: targetSlug })).status, 409);
    assert.equal((await api('pages/doclight-default-guide')).status, 200, 'a refused move must keep the source page');
    const moveParent = await api('pages', 'POST', { title: 'Move me', space: 'doclight-default' });
    const moveChild = await api('pages', 'POST', { title: 'Move child', space: 'doclight-default', parent: moveParent.body.slug });
    const movedOut = await api(`pages/${moveParent.body.slug}`, 'PUT', { space: targetSlug });
    assert.equal(movedOut.status, 200);
    assert.equal(movedOut.body.slug, 'move_me');
    assert.equal(movedOut.body.space, targetSlug);
    assert.ok(fs.existsSync(path.join(data, 'pages', 'move_me.md')));
    assert.equal(fs.existsSync(path.join(template, 'pages', 'move_me.md')), false);
    assert.equal(fs.existsSync(path.join(template, 'pages', 'move_child.md')), false);
    assert.equal((await api(`pages/${moveChild.body.slug}`)).status, 404);
    const movedChild = await api('pages/move_child');
    assert.equal(movedChild.status, 200);
    assert.equal(movedChild.body.space, targetSlug);
    assert.equal(movedChild.body.parent, 'move_me');
    const movedBack = await api('pages/move_me', 'PUT', { space: 'doclight-default' });
    assert.equal(movedBack.status, 200);
    assert.equal(movedBack.body.slug, 'doclight-default-move_me');
    assert.ok(fs.existsSync(path.join(template, 'pages', 'move_me.md')));
    assert.equal(fs.existsSync(path.join(data, 'pages', 'move_me.md')), false);
    assert.equal((await api('pages/doclight-default-move_child')).body.parent, 'doclight-default-move_me');
    // A home pointing into a moved-away subtree is cleared instead of dangling.
    const homePage = await api('pages', 'POST', { title: 'Home page', space: 'doclight-default' });
    const indexBefore = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    indexBefore.spaces.find((s: any) => s.slug === 'default').home = 'home_page';
    fs.writeFileSync(indexPath, JSON.stringify(indexBefore));
    assert.equal((await api(`pages/${homePage.body.slug}`, 'PUT', { space: targetSlug })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).spaces.find((s: any) => s.slug === 'default').home, null);
    // Deleting the built-in space removes every source page and leaves a tombstone, so a restart
    // neither recreates the space nor reports the template as broken.
    await stop(); cookie = ''; await start('true'); await login();
    const deletedSpace = await api('spaces/doclight-default', 'DELETE');
    assert.equal(deletedSpace.status, 200);
    assert.equal((await api('tree')).body.spaces.some((s: any) => s.builtIn), false);
    assert.deepEqual(fs.readdirSync(path.join(template, 'pages')).filter(name => name.endsWith('.md')), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(template, 'spaces.json'), 'utf8')).doclightBuiltInDeleted, true);
    await stop(); cookie = ''; await start('true');
    assert.equal((await api('tree')).body.spaces.some((s: any) => s.builtIn), false);
    assert.doesNotMatch(warnings, /模板缺失或无效/);
    console.log('developer mode integration assertions passed');
  } finally { await stop(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); if (warnings) console.error('server log:\n' + warnings); process.exitCode = 1; });
