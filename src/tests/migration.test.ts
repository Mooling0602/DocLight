/*
 * v3 (HTML) → v4 (Markdown) database migration.
 *
 * `readDb()` is the only place that rewrites existing user data on upgrade, so a regression in
 * the version check or the write-back would silently reset or corrupt a live site. This suite
 * boots a real server against a hand-written v3 pages.json and asserts the on-disk result:
 * the version flips to 4, every page keeps its identity and metadata, and the HTML body became
 * Markdown. A second boot must then be a no-op (the file is already v4) rather than a re-migration.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const readDisk = (dataDir: string) => JSON.parse(fs.readFileSync(path.join(dataDir, 'pages.json'), 'utf8'));

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-migration-'));
  fs.writeFileSync(path.join(dataDir, 'pages.json'), JSON.stringify(V3_DB, null, 2), 'utf8');

  /* ---- First boot migrates the file in place ---- */
  const server = await startServer(dataDir);
  try {
    // Migration happens on the first read, so touch the API before inspecting the disk.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pages/legacy`);
    const served = await res.json();

    const disk = readDisk(dataDir);
    assert.equal(disk.version, 4, '数据文件应升级为 v4');

    const legacy = disk.pages.find((p: any) => p.slug === 'legacy');
    assert.ok(legacy, '原有页面不应丢失');
    assert.equal(legacy.title, '旧页面', '标题应保留');
    assert.equal(legacy.space, 'default', '所属空间应保留');
    assert.equal(legacy.createdAt, V3_DB.pages[0].createdAt, 'createdAt 应保留');
    assert.equal(legacy.updatedAt, V3_DB.pages[0].updatedAt, 'updatedAt 应保留');

    // The HTML body became Markdown.
    assert.match(legacy.content, /^# 旧标题/m, '标题应变成 Markdown 标题');
    assert.match(legacy.content, /\*\*粗\*\*/, '粗体应变成 Markdown 强调');
    assert.match(legacy.content, /^- 一$/m, '列表应变成 Markdown 列表');
    assert.ok(!/<h1>|<ul>|<li>/.test(legacy.content), '结构性 HTML 标签应被转换掉');
    // Formats Markdown cannot express are preserved as inline HTML.
    assert.match(legacy.content, /<u>下划线<\/u>/, '下划线应保留为内联 HTML');
    assert.match(legacy.content, /<p style="text-align:center">居中<\/p>/, '内联样式应原样保留');

    // An empty page stays empty rather than gaining a stray newline.
    const empty = disk.pages.find((p: any) => p.slug === 'empty');
    assert.equal(empty.content, '', '空页面迁移后仍应为空');
    assert.equal(empty.parent, 'legacy', '父子关系应保留');
    assert.equal(disk.spaces[0].slug, 'default', '空间应保留');
    assert.equal(disk.spaces[0].home, 'legacy', '空间首页指向应保留');

    // The irreversible in-place rewrite leaves the pre-migration HTML behind, so a bad
    // conversion can be recovered instead of silently destroying the site's content.
    const backup = JSON.parse(fs.readFileSync(path.join(dataDir, 'pages.json.v3.bak'), 'utf8'));
    assert.equal(backup.version, 3, '备份应保留迁移前的 v3 数据');
    assert.equal(backup.pages[0].content, V3_DB.pages[0].content, '备份正文应为原始 HTML');

    // The API serves the migrated Markdown.
    assert.equal(served.content, legacy.content, '接口返回的正文应与磁盘一致');
  } finally {
    server.stop();
  }

  /* ---- Second boot is a no-op: already v4, so nothing is rewritten ---- */
  const before = fs.readFileSync(path.join(dataDir, 'pages.json'), 'utf8');
  const backupBefore = fs.readFileSync(path.join(dataDir, 'pages.json.v3.bak'), 'utf8');
  const again = await startServer(dataDir);
  again.stop();
  const after = fs.readFileSync(path.join(dataDir, 'pages.json'), 'utf8');
  assert.equal(after, before, '已迁移的数据再次启动不应被改写');
  assert.equal(
    fs.readFileSync(path.join(dataDir, 'pages.json.v3.bak'), 'utf8'),
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
