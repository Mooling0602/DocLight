/*
 * Renaming a page must keep the manual sort position the drag-and-drop editor gave it.
 *
 * A stored manual order is a flat list of slugs, so a rename that ignored it left the old slug
 * behind: the renamed page matched nothing in `applyManualOrder` and sank to the end of the space,
 * while the stale entry stayed around for a later page to inherit. These tests pin the server-side
 * repair for ordinary spaces (`data/spaces.json`) and for the source-backed built-in space
 * (`template/spaces.json`), plus the neighbouring cases that must stay untouched — a refused or
 * no-op rename, a page that was never arranged, and moves between the two kinds of space.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeFromOrder, renameInOrder } from '../sort.js';
import { BUILT_IN_SLUG } from '../store.js';

/* ---------------------------------------------------- order helpers */

{
  assert.deepEqual(renameInOrder(['a', 'b', 'c'], 'b', 'x'), ['a', 'x', 'c'], '改名在原位置替换，不改变先后次序');
  const same = ['a', 'b'];
  assert.equal(renameInOrder(same, 'missing', 'y'), same, '列表未提到该页面时原样返回');
  assert.equal(renameInOrder(undefined, 'a', 'b'), undefined, '没有 order 时不凭空生成');
  assert.equal(renameInOrder(same, 'a', 'a'), same, '同名不算改名');
  assert.deepEqual(renameInOrder(['a', 'b', 'c'], 'b', 'c'), ['a', 'c'], '替换产生的重复项只保留第一次出现');
  assert.deepEqual(removeFromOrder(['a', 'b'], ['b']), ['a']);
  assert.equal(removeFromOrder(['a'], ['a']), undefined, '清空后返回 undefined，调用方据此删除字段');
  const kept = ['a', 'b'];
  assert.equal(removeFromOrder(kept, ['z']), kept, '没有命中时原样返回');
}

/* ---------------------------------------------------- release harness */

const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-rename-order-'));
const release = path.join(temp, 'release');
const template = path.join(release, 'template');
const data = path.join(temp, 'data');
const templateIndexFile = path.join(template, 'spaces.json');
const dataIndexFile = path.join(data, 'spaces.json');
let child: ChildProcess | undefined;
let base = '';
let cookie = '';
let log = '';

async function start(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: '4770',
    DOCLIGHT_DATA_DIR: data,
    DOCLIGHT_DEV_MODE: 'true',
    DOCLIGHT_CONFIG: path.join(temp, 'absent.toml'),
    DOCLIGHT_HOST: '127.0.0.1',
  };
  delete env.DOCLIGHT_BASE_PATH;
  delete env.DOCLIGHT_STRICT_PORT;
  child = spawn(process.execPath, [path.join(release, 'dist/server.js')], { cwd: release, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const running = child;
  log = '';
  running.stderr!.on('data', (chunk) => { log += String(chunk); });
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
    running.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    running.once('error', reject);
  });
}

async function stop(): Promise<void> {
  const running = child; child = undefined;
  if (running && running.exitCode === null && running.signalCode === null) {
    await new Promise<void>((resolve) => { running.once('exit', () => resolve()); running.kill(); });
  }
}

async function api(endpoint: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json() };
}

async function login(): Promise<void> {
  const challenge = (await api('auth/challenge')).body;
  const proof = createHmac('sha256', Buffer.from('aa'.repeat(32), 'hex')).update(challenge.nonce).digest('hex');
  assert.equal((await api('auth/login', 'POST', { user: 'tester', nonce: challenge.nonce, proof })).status, 200);
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rawIndex = (file: string) => fs.readFileSync(file, 'utf8');
const templateSpace = () => readJson(templateIndexFile).spaces.find((space: any) => space.slug === 'default');
const dataSpace = (slug: string) => readJson(dataIndexFile).spaces.find((space: any) => space.slug === slug);

/** Slugs of one space in the order the API serves them, which is what the sidebar renders. */
async function served(space: string): Promise<string[]> {
  const tree = (await api('tree')).body;
  return tree.pages.filter((page: any) => page.space === space).map((page: any) => page.slug);
}
async function servedSpace(space: string): Promise<any> {
  return (await api('tree')).body.spaces.find((item: any) => item.slug === space);
}

async function main(): Promise<void> {
  try {
    fs.mkdirSync(release, { recursive: true });
    fs.cpSync(path.join(root, 'dist'), path.join(release, 'dist'), { recursive: true });
    fs.cpSync(path.join(root, 'template'), template, { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(release, 'node_modules'), 'dir');

    await start();
    assert.equal((await api('auth/setup', 'POST', { user: 'tester', ks: 'aa'.repeat(32) })).status, 200);

    /* ---- combined rename and parent changes must not create cycles --------- */
    assert.equal((await api('spaces', 'POST', { title: 'Cycle test' })).status, 201);
    for (const [title, parent] of [['Root node', null], ['Child node', 'root_node'], ['Grandchild node', 'child_node'], ['Other node', null]] as const) {
      assert.equal((await api('pages', 'POST', { title, space: 'cycle_test', parent })).status, 201);
    }
    assert.equal((await api('spaces/cycle_test', 'PUT', { sort: 'manual', order: ['root_node', 'child_node', 'grandchild_node', 'other_node'] })).status, 200);
    const beforeCycleIndex = rawIndex(dataIndexFile);
    const beforeCycleFiles = ['root_node', 'child_node', 'grandchild_node'].map(slug => fs.readFileSync(path.join(data, 'pages', `${slug}.md`), 'utf8'));
    for (const parent of ['renamed_root', 'child_node', 'grandchild_node']) {
      const rejected = await api('pages/root_node', 'PUT', { slug: 'renamed_root', parent });
      assert.equal(rejected.status, 400, '改路径时不能将页面置于自身或后代之下');
      assert.equal(rawIndex(dataIndexFile), beforeCycleIndex, '被拒绝的改路径不能改写空间索引');
      assert.equal(fs.existsSync(path.join(data, 'pages', 'renamed_root.md')), false, '被拒绝的改路径不能生成新文件');
      assert.deepEqual(['root_node', 'child_node', 'grandchild_node'].map(slug => fs.readFileSync(path.join(data, 'pages', `${slug}.md`), 'utf8')), beforeCycleFiles, '被拒绝的请求不能改写页面');
    }
    const validMove = await api('pages/root_node', 'PUT', { slug: 'renamed_root', parent: 'other_node' });
    assert.equal(validMove.status, 200, '允许改路径并移到无关页面之下');
    assert.equal(validMove.body.parent, 'other_node');
    assert.deepEqual(dataSpace('cycle_test').order, ['renamed_root', 'child_node', 'grandchild_node', 'other_node']);
    const broken = await api('pages', 'POST', { title: 'Broken header', space: 'cycle_test' });
    assert.equal(broken.status, 201);
    const brokenFile = path.join(data, 'pages', `${broken.body.slug}.md`);
    const brokenRaw = '---\ntitle: incomplete\n';
    fs.writeFileSync(brokenFile, brokenRaw);
    assert.equal((await api(`pages/${broken.body.slug}`)).body.unclosedFrontMatter, true, 'API 应提示编辑器保护未闭合的元数据');
    assert.equal((await api(`pages/${broken.body.slug}`, 'PUT', { content: 'replacement' })).status, 409, '服务端也必须拒绝覆盖不安全的元数据');
    assert.equal(fs.readFileSync(brokenFile, 'utf8'), brokenRaw, '被拒绝的保存不得修改原文件');
    assert.equal((await api(`pages/${broken.body.slug}`, 'DELETE')).status, 200, '验证后移除临时损坏页面，避免干扰后续模板事务');

    /* ---- ordinary space: rename keeps the manual position ------------------- */
    assert.equal((await api('spaces', 'POST', { title: 'Alpha' })).status, 201);
    assert.equal((await api('spaces', 'POST', { title: 'Beta' })).status, 201);
    for (const title of ['Page a', 'Page b', 'Page c']) {
      assert.equal((await api('pages', 'POST', { title, space: 'alpha' })).status, 201);
    }
    const ordered = await api('spaces/alpha', 'PUT', { sort: 'manual', order: ['page_c', 'page_a', 'page_b'] });
    assert.equal(ordered.status, 200);
    assert.deepEqual(ordered.body.order, ['page_c', 'page_a', 'page_b']);
    assert.deepEqual(await served('alpha'), ['page_c', 'page_a', 'page_b'], '手动顺序先要在界面上生效');

    // Ordinary page metadata is not part of the editor body, and survives path edits.
    const sourceFile = path.join(data, 'pages', 'page_a.md');
    const sourceRaw = fs.readFileSync(sourceFile, 'utf8').replace('\n---\n\n', '\ncustom: keep # hand-written metadata\n---\n\n');
    fs.writeFileSync(sourceFile, sourceRaw);
    assert.doesNotMatch((await api('pages/page_a')).body.content, /custom: keep/, '元数据不能进入编辑正文');
    const exactBody = '# 更新正文\n\n末尾硬换行  \n\n';
    assert.equal((await api('pages/page_a', 'PUT', { content: exactBody })).status, 200);
    assert.match(fs.readFileSync(sourceFile, 'utf8'), /custom: keep # hand-written metadata/, '保存正文应保留手写元数据');
    assert.equal((await api('pages/page_a')).body.content, exactBody, '保存后应保留 Markdown 尾部空格和空行');
    // The regression: page_a sits between page_c and page_b, so the renamed page must stay there.
    const renamed = await api('pages/page_a', 'PUT', { slug: 'page_a2' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.slug, 'page_a2');
    assert.deepEqual(dataSpace('alpha').order, ['page_c', 'page_a2', 'page_b'], '普通空间改名后 order 指向新 slug 且位置不变');
    assert.deepEqual(await served('alpha'), ['page_c', 'page_a2', 'page_b'], '侧边栏顺序在改名后保持不变');
    assert.equal(fs.existsSync(path.join(data, 'pages', 'page_a.md')), false, '旧页面文件已删除');
    assert.ok(fs.existsSync(path.join(data, 'pages', 'page_a2.md')), '新页面文件已写入');
    assert.match(fs.readFileSync(path.join(data, 'pages', 'page_a2.md'), 'utf8'), /custom: keep # hand-written metadata/, '页面路径修改应保留自定义元数据和注释');

    // Moving within the same space must not remove the page from its manual order.
    assert.equal((await api('pages/page_a2', 'PUT', { space: 'alpha', parent: null })).status, 200);
    assert.deepEqual(dataSpace('alpha').order, ['page_c', 'page_a2', 'page_b'], '同空间移动保留手动顺序');

    // A refused rename must not touch the index at all.
    const before = rawIndex(dataIndexFile);
    assert.equal((await api('pages/page_b', 'PUT', { slug: 'page_a2' })).status, 400, '占用中的 slug 被拒绝');
    assert.equal((await api('pages/page_b', 'PUT', { slug: 'Bad Slug' })).status, 400, '非法 slug 被拒绝');
    assert.equal(rawIndex(dataIndexFile), before, '被拒绝的改名不写索引');

    // The same slug is a no-op, not a rewrite.
    assert.equal((await api('pages/page_b', 'PUT', { slug: 'page_b' })).status, 200);
    assert.equal(rawIndex(dataIndexFile), before, '同名提交不改动索引');

    // A page that was never arranged stays unarranged: the rename must not invent a position.
    assert.equal((await api('pages', 'POST', { title: 'Page d', space: 'alpha' })).status, 201);
    const unlisted = rawIndex(dataIndexFile);
    assert.equal((await api('pages/page_d', 'PUT', { slug: 'page_d2' })).status, 200);
    assert.equal(rawIndex(dataIndexFile), unlisted, '未参与排序的页面改名不写入 order');
    assert.deepEqual(dataSpace('alpha').order, ['page_c', 'page_a2', 'page_b']);
    const alphaOrder = await served('alpha');
    assert.deepEqual(alphaOrder.slice(0, 3), ['page_c', 'page_a2', 'page_b'], '已排序页面仍在前');
    assert.ok(alphaOrder.includes('page_d2'), '改名后的未排序页面仍在空间内');

    // Moving a page out of the space drops its position instead of leaving a ghost entry.
    assert.equal((await api('pages/page_a2', 'PUT', { space: 'beta' })).status, 200);
    assert.deepEqual(dataSpace('alpha').order, ['page_c', 'page_b'], '移出空间的页面不再占据 order 位置');
    const alphaAfterMove = await served('alpha');
    assert.deepEqual(alphaAfterMove.slice(0, 2), ['page_c', 'page_b'], '移出后剩余页面顺序不变');
    assert.ok(alphaAfterMove.includes('page_d2'), '未参与排序的页面仍在空间内');
    assert.deepEqual(await served('beta'), ['page_a2'], '移入空间的页面作为未排序页追加');

    // Deleting a page drops its position; deleting the last arranged page drops the whole key.
    assert.equal((await api('pages/page_b', 'DELETE')).status, 200);
    assert.deepEqual(dataSpace('alpha').order, ['page_c'], '删除页面后 order 只少了它自己');
    assert.equal((await api('pages/page_c', 'DELETE')).status, 200);
    assert.equal('order' in dataSpace('alpha'), false, 'order 清空后字段被删除');
    assert.equal(dataSpace('alpha').sort, 'manual', '清空 order 不改变排序方式');

    // Manual mode with no list at all is the same case: a rename must not start one.
    const bare = rawIndex(dataIndexFile);
    assert.equal((await api('pages/page_d2', 'PUT', { slug: 'page_d3' })).status, 200);
    assert.equal(rawIndex(dataIndexFile), bare, '没有 order 的手动空间改名不生成 order');
    assert.deepEqual(await served('alpha'), ['page_d3'], '页面仍在空间内，只是没有排列');

    /* ---- built-in space: rename keeps the source order ---------------------- */
    const initial = templateSpace();
    assert.deepEqual(initial.order, ['welcome', 'guide', 'changelog']);
    assert.equal(initial.home, 'welcome');
    assert.equal(rawIndex(templateIndexFile), JSON.stringify(readJson(templateIndexFile), null, 2) + '\n', '索引按固定格式序列化');
    assert.deepEqual(await served('doclight-default'), ['doclight-default-welcome', 'doclight-default-guide', 'doclight-default-changelog']);

    // guide is the middle entry: the regression made it fall behind the manual order entirely.
    assert.equal((await api('pages/doclight-default-guide', 'PUT', { slug: 'intro' })).status, 200);
    let index = templateSpace();
    assert.deepEqual(index.order, ['welcome', 'intro', 'changelog'], '内置空间改名后模板 order 指向新文件名且位置不变');
    assert.equal(index.home, 'welcome', '未被改名的 home 不受影响');
    assert.deepEqual(await served('doclight-default'), ['doclight-default-welcome', 'doclight-default-intro', 'doclight-default-changelog']);
    assert.equal(fs.existsSync(path.join(template, 'pages', 'guide.md')), false);
    assert.ok(fs.existsSync(path.join(template, 'pages', 'intro.md')));

    // The home pointer follows a rename of the home page, together with its order entry.
    assert.equal((await api('pages/doclight-default-welcome', 'PUT', { slug: 'hello' })).status, 200);
    index = templateSpace();
    assert.deepEqual(index.order, ['hello', 'intro', 'changelog'], '改名主页时 order 与 home 一起跟随');
    assert.equal(index.home, 'hello');
    const builtIn = await servedSpace('doclight-default');
    assert.equal(builtIn.home, 'doclight-default-hello');
    assert.deepEqual(builtIn.order, ['doclight-default-hello', 'doclight-default-intro', 'doclight-default-changelog'], 'API 中的 order 翻译成虚拟 slug');
    assert.equal(builtIn.sort, 'manual');

    // Refused and no-op renames leave the template index byte-identical.
    const stable = rawIndex(templateIndexFile);
    assert.equal((await api('pages/doclight-default-changelog', 'PUT', { slug: 'intro' })).status, 409, '占用中的文件名被拒绝');
    assert.equal((await api('pages/doclight-default-changelog', 'PUT', { slug: 'Bad Slug' })).status, 400, '非法 slug 被拒绝');
    assert.equal((await api('pages/doclight-default-changelog', 'PUT', { slug: 'spaces' })).status, 400, '保留字被拒绝');
    assert.equal(rawIndex(templateIndexFile), stable, '被拒绝的内置改名不写索引');
    assert.equal((await api('pages/doclight-default-hello', 'PUT', { slug: 'hello' })).status, 200);
    assert.equal(rawIndex(templateIndexFile), stable, '同名提交不改动内置索引');

    // A freshly created page is not part of the arrangement, so its rename must not add one.
    const created = await api('pages', 'POST', { title: 'Extra', space: 'doclight-default' });
    assert.equal(created.status, 201);
    const unarranged = rawIndex(templateIndexFile);
    assert.equal((await api(`pages/${created.body.slug}`, 'PUT', { slug: 'extra2' })).status, 200);
    assert.equal(rawIndex(templateIndexFile), unarranged, '未参与排序的内置页面改名不写入 order');

    // Deleting a subtree removes every entry it owned, in place.
    const parent = await api('pages', 'POST', { title: 'Parent', space: 'doclight-default' });
    const child = await api('pages', 'POST', { title: 'Child', space: 'doclight-default', parent: parent.body.slug });
    const arrange = await api('spaces/doclight-default', 'PUT', { order: await served('doclight-default') });
    assert.equal(arrange.status, 200);
    // Everything the space holds is now arranged, in the order the API serves it.
    const arrangedSources = (arrange.body.order as string[]).map(slug => slug.slice(BUILT_IN_SLUG.length + 1));
    assert.deepEqual(templateSpace().order, arrangedSources, '模板 order 存源文件名，与 API 的虚拟 slug 一一对应');
    assert.deepEqual(await served('doclight-default'), arrange.body.order, '写回的排列与读出的排列一致');
    const parentSource = parent.body.slug.slice(BUILT_IN_SLUG.length + 1);
    const childSource = child.body.slug.slice(BUILT_IN_SLUG.length + 1);
    assert.equal((await api(`pages/${parent.body.slug}`, 'DELETE')).status, 200);
    assert.deepEqual(templateSpace().order, arrangedSources.filter(slug => slug !== parentSource && slug !== childSource), '删除子树后父页面与子页面的位置一并移除');
    assert.equal((await api(`pages/${child.body.slug}`)).status, 404);

    // Moving a page out of the built-in space removes its source entry from the template order.
    const shift = await api('pages', 'POST', { title: 'Shift', space: 'doclight-default' });
    const shiftArranged = await api('spaces/doclight-default', 'PUT', { order: await served('doclight-default') });
    assert.equal(shiftArranged.status, 200);
    const shiftSource = shift.body.slug.slice(BUILT_IN_SLUG.length + 1);
    assert.ok(templateSpace().order.includes(shiftSource), '新页面也进入排列');
    assert.equal((await api(`pages/${shift.body.slug}`, 'PUT', { space: 'beta' })).status, 200);
    assert.deepEqual(templateSpace().order, (shiftArranged.body.order as string[]).map(slug => slug.slice(BUILT_IN_SLUG.length + 1)).filter(slug => slug !== shiftSource), '移入普通空间的内置页面不再占据模板 order');
    assert.ok(fs.existsSync(path.join(data, 'pages', 'shift.md')), '页面文件已落到普通空间');

    // The reverse move clears the ordinary index the page came from.
    const back = await api('pages', 'POST', { title: 'Back', space: 'beta' });
    assert.equal((await api('spaces/beta', 'PUT', { sort: 'manual', order: [back.body.slug] })).status, 200);
    assert.deepEqual(dataSpace('beta').order, ['back']);
    const beforeMoveBack = templateSpace().order;
    assert.equal((await api(`pages/${back.body.slug}`, 'PUT', { space: 'doclight-default' })).status, 200);
    assert.equal('order' in dataSpace('beta'), false, '移回内置空间后普通空间的 order 字段被删除');
    assert.deepEqual(templateSpace().order, beforeMoveBack, '移入内置空间不改变模板 order');

    // Everything above must survive a restart: the index is the durable record.
    const orderBeforeRestart: string[] = templateSpace().order;
    const servedBeforeRestart = await served('doclight-default');
    await stop(); cookie = ''; await start(); await login();
    const persisted = templateSpace();
    assert.equal(persisted.home, 'hello');
    assert.equal(persisted.sort, 'manual');
    assert.deepEqual(persisted.order, orderBeforeRestart, '重启后 order 与写入时一致');
    const afterRestart = await served('doclight-default');
    assert.deepEqual(afterRestart, servedBeforeRestart, '重启后读出的顺序与写入前一致');
    // The page moved back from the ordinary space is appended, not arranged.
    const arrangedBack = orderBeforeRestart.map((slug: string) => `${BUILT_IN_SLUG}-${slug}`);
    assert.deepEqual(afterRestart.slice(0, arrangedBack.length), arrangedBack, '已排列页面仍在前');
    assert.deepEqual(afterRestart.slice(arrangedBack.length), ['doclight-default-back'], '移回的页面作为未排序页追加');
    assert.equal(dataSpace('beta').sort, 'manual');
    assert.equal('order' in dataSpace('beta'), false);

    console.log('page rename order assertions passed');
  } finally {
    await stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  if (log) console.error('server log:\n' + log);
  process.exitCode = 1;
});
