/*
 * Legacy `pages.json` → Markdown-file store migration.
 *
 * The store keeps one `<slug>.md` per page (see src/store.ts). Upgrading from the old single
 * `pages.json` (v3 with HTML bodies, or v4 with Markdown bodies) rewrites user data, so a
 * regression would silently reset or corrupt a live site. This suite boots a real server
 * against a hand-written v3 file and asserts the on-disk result: the pages become Markdown
 * files that keep their identity and metadata, the HTML body is converted, the original is
 * backed up, and a second boot is a no-op rather than a re-migration.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

/** Boot dist/server.js isolated from the developer's config, on a scraped port. */
function startServer(dataDir: string): Promise<StartedServer> {
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['PORT', 'DOCLIGHT_HOST', 'DOCLIGHT_STRICT_PORT', 'DOCLIGHT_DATA_DIR']) delete baseEnv[key];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: { ...baseEnv, PORT: '4750', DOCLIGHT_DATA_DIR: dataDir, DOCLIGHT_CONFIG: path.join(dataDir, 'absent.toml') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start in time:\n' + output)); }, 15000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ port: Number(match[1]), dataDir, stop: () => child.kill() });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited early with code ${code}:\n${output}`)); });
  });
}

const V3_DB = {
  version: 3,
  spaces: [{ slug: 'default', title: '旧空间', desc: '迁移测试', home: 'legacy', createdAt: 1700000000000, updatedAt: 1700000000000 }],
  pages: [
    {
      slug: 'legacy',
      space: 'default',
      parent: null,
      title: '旧页面',
      // HTML as written by the v3 WYSIWYG editor, including a non-Markdown underline and an
      // inline style that must survive as raw inline HTML.
      content: '<h1>旧标题</h1>\n<p>正文 <b>粗</b> 与 <u>下划线</u>。</p>\n<ul><li>一</li><li>二</li></ul>\n<p style="text-align:center">居中</p>',
      createdAt: 1700000000001,
      updatedAt: 1700000000002,
    },
    {
      slug: 'empty',
      space: 'default',
      parent: 'legacy',
      title: '空页面',
      content: '',
      createdAt: 1700000000003,
      updatedAt: 1700000000004,
    },
  ],
};

/** Parse a stored page file into its front matter and body. */
function readPageFile(dataDir: string, slug: string): { meta: Record<string, unknown>; body: string } {
  const raw = fs.readFileSync(path.join(dataDir, 'pages', `${slug}.md`), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  assert.ok(match, `${slug}.md 应带 YAML front matter`);
  return { meta: YAML.parse(match![1]), body: match![2].replace(/\n$/, '') };
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-migration-'));
  fs.writeFileSync(path.join(dataDir, 'pages.json'), JSON.stringify(V3_DB, null, 2), 'utf8');

  /* ---- First boot migrates the single file into the Markdown store ---- */
  const server = await startServer(dataDir);
  try {
    // Migration happens on the first read, so touch the API before inspecting the disk.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pages/legacy`);
    const served = await res.json();

    // The legacy file is replaced by real .md files plus a spaces file.
    assert.ok(fs.existsSync(path.join(dataDir, 'spaces.json')), '应生成 spaces.json');
    assert.ok(fs.existsSync(path.join(dataDir, 'pages', 'legacy.md')), '每个页面应落成 .md 文件');
    assert.ok(fs.existsSync(path.join(dataDir, 'pages', 'empty.md')), '空页面也应落成 .md 文件');

    const legacy = readPageFile(dataDir, 'legacy');
    assert.equal(legacy.meta.title, '旧页面', '标题应保留在 front matter');
    assert.equal(legacy.meta.space, 'default', '所属空间应保留');
    assert.equal(legacy.meta.parent, null, 'parent 应保留');
    assert.equal(legacy.meta.createdAt, V3_DB.pages[0].createdAt, 'createdAt 应保留');
    assert.equal(legacy.meta.updatedAt, V3_DB.pages[0].updatedAt, 'updatedAt 应保留');

    // The HTML body became Markdown in the file body.
    assert.match(legacy.body, /^# 旧标题/m, '标题应变成 Markdown 标题');
    assert.match(legacy.body, /\*\*粗\*\*/, '粗体应变成 Markdown 强调');
    assert.match(legacy.body, /^- 一$/m, '列表应变成 Markdown 列表');
    assert.ok(!/<h1>|<ul>|<li>/.test(legacy.body), '结构性 HTML 标签应被转换掉');
    // Formats Markdown cannot express are preserved as inline HTML.
    assert.match(legacy.body, /<u>下划线<\/u>/, '下划线应保留为内联 HTML');
    assert.match(legacy.body, /<p style="text-align:center">居中<\/p>/, '内联样式应原样保留');

    // An empty page stays empty rather than gaining a stray newline.
    const empty = readPageFile(dataDir, 'empty');
    assert.equal(empty.body, '', '空页面迁移后仍应为空');
    assert.equal(empty.meta.parent, 'legacy', '父子关系应保留');

    const spaces = JSON.parse(fs.readFileSync(path.join(dataDir, 'spaces.json'), 'utf8'));
    assert.equal(spaces.spaces[0].slug, 'default', '空间应保留');
    assert.equal(spaces.spaces[0].home, 'legacy', '空间首页指向应保留');

    // The irreversible rewrite leaves the original behind, so a bad conversion is recoverable.
    const backup = JSON.parse(fs.readFileSync(path.join(dataDir, 'pages.json.bak'), 'utf8'));
    assert.equal(backup.version, 3, '备份应保留迁移前的 v3 数据');
    assert.equal(backup.pages[0].content, V3_DB.pages[0].content, '备份正文应为原始 HTML');

    // The API serves the migrated Markdown.
    assert.equal(served.content, legacy.body, '接口返回的正文应与文件一致');
  } finally {
    server.stop();
  }

  /* ---- Second boot is a no-op: the store already exists ---- */
  const pageFile = path.join(dataDir, 'pages', 'legacy.md');
  const before = fs.readFileSync(pageFile, 'utf8');
  const backupBefore = fs.readFileSync(path.join(dataDir, 'pages.json.bak'), 'utf8');
  const again = await startServer(dataDir);
  again.stop();
  assert.equal(fs.readFileSync(pageFile, 'utf8'), before, '已迁移的页面文件再次启动不应被改写');
  assert.equal(
    fs.readFileSync(path.join(dataDir, 'pages.json.bak'), 'utf8'),
    backupBefore,
    '已存在的备份不应被覆盖',
  );

  /* ---- Migration retires the legacy file so it cannot shadow the store ---- */
  // Leaving `pages.json` in place would let a later lost `spaces.json` re-import this stale
  // snapshot over the user's edits. The store is authoritative once written, so the legacy file
  // must be moved aside (its bytes kept as `.bak`).
  assert.ok(
    !fs.existsSync(path.join(dataDir, 'pages.json')),
    '迁移完成后旧 pages.json 不应继续留在数据目录',
  );
  assert.ok(fs.existsSync(path.join(dataDir, 'pages.json.bak')), '旧数据应保留为 .bak 备份');

  /* ---- A lost spaces.json must not cost the user their pages ---- */
  // The spaces index is derived data, so seeding the sample over a directory that still holds
  // pages would replace every page sharing a sample name (welcome/guide/changelog). The store
  // is repaired from the page files instead; this is asserted end-to-end through a real boot.
  //
  // The backup is removed too, so the situation is exactly "index gone, pages present" with no
  // legacy file left to fall through to.
  fs.rmSync(path.join(dataDir, 'spaces.json'), { force: true });
  fs.rmSync(path.join(dataDir, 'pages.json.bak'), { force: true });
  // A page named after a shipped sample is planted first: without recovery the seeding path
  // would replace it with the sample, which a plain "the legacy page still loads" check misses.
  fs.writeFileSync(
    path.join(dataDir, 'pages', 'welcome.md'),
    '---\ntitle: 用户自己的欢迎页\nspace: default\n---\n\n这是我的内容，不是示例。\n',
    'utf8',
  );
  const repaired = await startServer(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${repaired.port}/api/pages/legacy`);
    assert.equal(res.status, 200, '缺少 spaces.json 时既有页面仍应可读');
    assert.match((await res.json()).content, /^# 旧标题/m, '页面正文应原样保留');

    const welcome = fs.readFileSync(path.join(dataDir, 'pages', 'welcome.md'), 'utf8');
    assert.match(welcome, /这是我的内容，不是示例/, '同名页面不得被示例数据覆盖');
    assert.doesNotMatch(welcome, /欢迎使用 DocLight ✦/, '同名页面不得被示例数据覆盖');

    const files = fs.readdirSync(path.join(dataDir, 'pages')).sort();
    assert.deepEqual(files, ['empty.md', 'legacy.md', 'welcome.md'], '不得引入示例页面或删除既有页面');
    assert.ok(fs.existsSync(path.join(dataDir, 'spaces.json')), '重建后应写回 spaces.json');
    const rebuilt = JSON.parse(fs.readFileSync(path.join(dataDir, 'spaces.json'), 'utf8'));
    assert.deepEqual(rebuilt.spaces.map((s: any) => s.slug), ['default'], '空间索引应据页面重建');
  } finally {
    repaired.stop();
  }

  /* ---- A lingering legacy file must not revert later edits when the index is lost ---- */
  // The exact regression this guards: migration writes pages/*.md but (before the fix) left
  // pages.json behind. The user then edits a page; if spaces.json is later lost, the stale
  // pages.json would be re-imported and silently overwrite the edit. Retirement makes the store
  // the only source of truth after migration.
  const editDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-migration-edit-'));
  fs.writeFileSync(path.join(editDir, 'pages.json'), JSON.stringify(V3_DB, null, 2), 'utf8');
  const firstRun = await startServer(editDir);
  await fetch(`http://127.0.0.1:${firstRun.port}/api/pages/legacy`);
  firstRun.stop();

  // Simulate the user's edit straight in the Markdown file.
  const editedFile = path.join(editDir, 'pages', 'legacy.md');
  fs.writeFileSync(
    editedFile,
    fs.readFileSync(editedFile, 'utf8').replace('# 旧标题', '# 用户后来改的标题'),
    'utf8',
  );
  // Lose the index; the legacy file must be gone, so recovery (not re-migration) must run.
  fs.rmSync(path.join(editDir, 'spaces.json'), { force: true });
  fs.rmSync(path.join(editDir, 'pages.json.bak'), { force: true });

  const afterLose = await startServer(editDir);
  try {
    const body = fs.readFileSync(editedFile, 'utf8');
    assert.match(body, /# 用户后来改的标题/, '索引丢失后用户的编辑必须保留');
    assert.doesNotMatch(body, /# 旧标题$/, '不得用迁移前的旧内容覆盖用户编辑');
  } finally {
    afterLose.stop();
    fs.rmSync(editDir, { recursive: true, force: true });
  }

  /* ---- A legacy file and hand-written pages together: both survive ---- */
  // The legacy file is the site's real data and must be migrated; a page already in `pages/`
  // must not be swept away as an orphan by that migration.
  const bothDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-migration-both-'));
  fs.writeFileSync(path.join(bothDir, 'pages.json'), JSON.stringify(V3_DB, null, 2), 'utf8');
  fs.mkdirSync(path.join(bothDir, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(bothDir, 'pages', 'handwritten.md'), '# 手写\n\n手写内容\n', 'utf8');

  const both = await startServer(bothDir);
  try {
    await fetch(`http://127.0.0.1:${both.port}/api/pages/legacy`);
    const files = fs.readdirSync(path.join(bothDir, 'pages')).sort();
    assert.deepEqual(files, ['empty.md', 'handwritten.md', 'legacy.md'], '迁移与手写页面应共存');
    assert.match(
      fs.readFileSync(path.join(bothDir, 'pages', 'handwritten.md'), 'utf8'),
      /手写内容/,
      '迁移不得删除已存在的手写页面',
    );
    assert.ok(fs.existsSync(path.join(bothDir, 'pages', 'legacy.md')), '旧数据仍应被迁移');
  } finally {
    both.stop();
    fs.rmSync(bothDir, { recursive: true, force: true });
  }

  /* ---- An index with no spaces is repaired from the pages, not clicked through ---- */
  // `{"spaces":[]}` parses, so storeExists() is true and startup used to return early. But with no
  // space to fall back to, readStore collapsed every page onto 'default' and the next write
  // persisted it, silently losing the real grouping. Startup must rebuild from the page files.
  const blankIdxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-migration-blankidx-'));
  fs.mkdirSync(path.join(blankIdxDir, 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(blankIdxDir, 'pages', 'mine.md'),
    '---\ntitle: 我的页\nspace: myspace\n---\n\n正文\n',
    'utf8',
  );
  fs.writeFileSync(path.join(blankIdxDir, 'spaces.json'), '{"version":4,"spaces":[]}', 'utf8');

  const blankBoot = await startServer(blankIdxDir);
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(blankIdxDir, 'spaces.json'), 'utf8'));
    assert.deepEqual(idx.spaces.map((s: any) => s.slug), ['myspace'], '空索引应按页面重建出真实空间');
    // The page's own front matter must be untouched by the repair.
    assert.match(
      fs.readFileSync(path.join(blankIdxDir, 'pages', 'mine.md'), 'utf8'),
      /\nspace: myspace\n/,
      '修复不应改写页面自身的空间归属',
    );
  } finally {
    blankBoot.stop();
    fs.rmSync(blankIdxDir, { recursive: true, force: true });
  }

  /* ---- A site the user emptied on purpose is left alone, not re-seeded ---- */
  // The inverse of the case above: an empty index with no pages is a legitimate state, so seeding
  // the sample over it would resurrect content the user deleted.
  const emptiedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-migration-emptied-'));
  fs.mkdirSync(path.join(emptiedDir, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(emptiedDir, 'spaces.json'), '{"version":4,"spaces":[]}', 'utf8');
  const emptiedBoot = await startServer(emptiedDir);
  emptiedBoot.stop();
  try {
    assert.equal(
      fs.readdirSync(path.join(emptiedDir, 'pages')).length,
      0,
      '用户清空后的站点不应被示例数据填充',
    );
  } finally {
    fs.rmSync(emptiedDir, { recursive: true, force: true });
  }

  /* ---- A legacy file that reappears beside its backup must not revert edits ---- */
  // The exact path that a bare `existsSync` check missed: retire failed (or the file was copied
  // back in), so `pages.json` coexists with the `.bak` after a migration already ran. Migrating it
  // would re-import the stale snapshot over the user's edits; it must be retired and the store
  // rebuilt from the page files instead.
  const reappearDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-migration-reappear-'));
  fs.writeFileSync(path.join(reappearDir, 'pages.json'), JSON.stringify(V3_DB, null, 2), 'utf8');
  const firstBoot = await startServer(reappearDir);
  await fetch(`http://127.0.0.1:${firstBoot.port}/api/pages/legacy`);
  firstBoot.stop();

  const liveFile = path.join(reappearDir, 'pages', 'legacy.md');
  fs.writeFileSync(liveFile, fs.readFileSync(liveFile, 'utf8').replace('# 旧标题', '# 用户改过的标题'), 'utf8');
  // Retire "fails": the legacy file is back in place while its backup still exists.
  fs.copyFileSync(path.join(reappearDir, 'pages.json.bak'), path.join(reappearDir, 'pages.json'));
  fs.rmSync(path.join(reappearDir, 'spaces.json'), { force: true });

  const afterReappear = await startServer(reappearDir);
  try {
    assert.match(fs.readFileSync(liveFile, 'utf8'), /# 用户改过的标题/, '残留旧文件不得覆盖用户编辑');
    assert.ok(!fs.existsSync(path.join(reappearDir, 'pages.json')), '残留的 pages.json 应被移走');
    assert.ok(fs.existsSync(path.join(reappearDir, 'spaces.json')), '索引应被重建');
  } finally {
    afterReappear.stop();
    fs.rmSync(reappearDir, { recursive: true, force: true });
  }

  /* ---- A differing legacy file is preserved, not discarded as a duplicate ---- */
  // The "backup already exists" case was treated as proof of duplication and the file deleted.
  // That is only true when the bytes match; a snapshot carried in from another machine differs
  // and its pages would be lost silently.
  const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-migration-dup-'));
  fs.mkdirSync(path.join(dupDir, 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dupDir, 'spaces.json'),
    '{"version":4,"spaces":[{"slug":"default","title":"S","desc":"","home":null,"createdAt":1,"updatedAt":1}]}',
    'utf8',
  );
  fs.writeFileSync(path.join(dupDir, 'pages.json.bak'), JSON.stringify(V3_DB, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(dupDir, 'pages.json'),
    JSON.stringify({ version: 3, spaces: V3_DB.spaces, pages: [{ ...V3_DB.pages[0], slug: 'fromelsewhere', title: '别处的快照' }] }),
    'utf8',
  );
  const dupBoot = await startServer(dupDir);
  dupBoot.stop();
  try {
    assert.ok(!fs.existsSync(path.join(dupDir, 'pages.json')), '残留文件应被移走以免遮挡 store');
    const kept = fs.readdirSync(dupDir).filter(n => n.startsWith('pages.json') && n !== 'pages.json');
    assert.ok(kept.some(n => n !== 'pages.json.bak'), '内容不同的文件应以新名字保留而非删除');
    const allKept = kept.map(n => fs.readFileSync(path.join(dupDir, n), 'utf8')).join('\n');
    assert.match(allKept, /别处的快照/, '另一份文件的内容必须保全');
  } finally {
    fs.rmSync(dupDir, { recursive: true, force: true });
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('migration assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
