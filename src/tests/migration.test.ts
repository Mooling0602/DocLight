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

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('migration assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
