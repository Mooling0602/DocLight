/*
 * File-backed page store (src/store.ts).
 *
 * Pages live as real Markdown files (`pages/<slug>.md`, YAML front matter) so they can be
 * exported, edited offline and put under version control. This suite pins the properties that
 * make that promise hold: a clean round-trip, tolerance of hand-edited files, removal of
 * orphaned files on delete/rename, and no needless rewrites that would churn `git`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStore, writeStore, storeExists } from '../store.js';
import type { Database, Page } from '../store.js';

function page(slug: string, over: Partial<Page> = {}): Page {
  return {
    slug,
    space: 'default',
    parent: null,
    title: `标题 ${slug}`,
    content: `# ${slug}\n\n正文 **粗** 与 <u>下划线</u>。`,
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    ...over,
  };
}

function db(...pages: Page[]): Database {
  return {
    version: 4,
    spaces: [{ slug: 'default', title: '空间', desc: '说明', home: null, createdAt: 1, updatedAt: 2 }],
    pages,
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-'));
const pageFile = (slug: string) => path.join(dir, 'pages', `${slug}.md`);

try {
  /* ---- A fresh store is seeded and read back identically ---- */
  assert.equal(storeExists(dir), false, '新目录不应被视为已有 store');
  writeStore(dir, db(page('alpha'), page('beta', { parent: 'alpha' })));
  assert.equal(storeExists(dir), true, '写入后应视为已有 store');
  assert.ok(fs.existsSync(pageFile('alpha')), '每个页面应落成一个 .md 文件');
  assert.ok(fs.existsSync(path.join(dir, 'spaces.json')), '空间应写入 spaces.json');

  // The file opens with a front matter block and a Markdown body.
  const raw = fs.readFileSync(pageFile('alpha'), 'utf8');
  assert.match(raw, /^---\n/, '.md 文件应以 YAML front matter 开头');
  assert.match(raw, /\ntitle: 标题 alpha\n/, 'front matter 应包含标题');
  assert.match(raw, /\n\n# alpha\n/, 'front matter 后应是 Markdown 正文');
  assert.ok(raw.endsWith('\n'), '.md 文件应以换行结尾');

  const back = readStore(dir);
  assert.equal(back.pages.length, 2, '应读回两个页面');
  const alpha = back.pages.find(p => p.slug === 'alpha')!;
  assert.equal(alpha.title, '标题 alpha', '标题应往返一致');
  assert.equal(alpha.content, page('alpha').content, '正文应往返一致');
  assert.equal(alpha.createdAt, 1700000000000, 'createdAt 应往返一致');
  const beta = back.pages.find(p => p.slug === 'beta')!;
  assert.equal(beta.parent, 'alpha', '父子关系应往返一致');

  /* ---- An unchanged store is not rewritten (no mtime churn for git / watchers) ---- */
  const mtimeBefore = fs.statSync(pageFile('alpha')).mtimeMs;
  writeStore(dir, back);
  assert.equal(fs.statSync(pageFile('alpha')).mtimeMs, mtimeBefore, '内容未变时不应重写文件');

  /* ---- Deleting a page removes its file instead of leaving an orphan ---- */
  writeStore(dir, db(page('alpha')));
  assert.equal(fs.existsSync(pageFile('beta')), false, '删除的页面文件应被移除');

  /* ---- Renaming a page moves the file ---- */
  writeStore(dir, db(page('alpha', { slug: 'gamma' })));
  assert.equal(fs.existsSync(pageFile('alpha')), false, '重命名后旧文件应消失');
  assert.equal(fs.existsSync(pageFile('gamma')), true, '重命名后应产生新文件');

  /* ---- A hand-written file without front matter is readable ---- */
  fs.writeFileSync(pageFile('note'), '# 手写标题\n\n直接写的正文。\n', 'utf8');
  const handEdited = readStore(dir);
  const note = handEdited.pages.find(p => p.slug === 'note')!;
  assert.equal(note.title, '手写标题', '无 front matter 时应从首个标题推断标题');
  assert.equal(note.content, '# 手写标题\n\n直接写的正文。', '无 front matter 的正文应完整保留');

  /* ---- A file with unknown front matter keys is still readable ---- */
  fs.writeFileSync(pageFile('extra'), '---\ntitle: 额外\nspace: default\ncustom: 忽略我\n---\n\n正文', 'utf8');
  const withExtra = readStore(dir);
  assert.equal(withExtra.pages.find(p => p.slug === 'extra')!.title, '额外', '未知键不应影响解析');

  /* ---- A page pointing at an unknown space falls back instead of vanishing ---- */
  fs.writeFileSync(pageFile('orphan'), '---\ntitle: 孤儿\nspace: gone\n---\n\n正文', 'utf8');
  const orphan = readStore(dir).pages.find(p => p.slug === 'orphan')!;
  assert.equal(orphan.space, 'default', '未知空间应回退到第一个空间，页面不应丢失');

  /* ---- A file whose name is not a valid slug is left alone, not deleted ---- */
  fs.writeFileSync(path.join(dir, 'pages', 'README.md'), '随手写的说明，不是页面。\n', 'utf8');
  writeStore(dir, readStore(dir));
  assert.ok(
    fs.existsSync(path.join(dir, 'pages', 'README.md')),
    '文件名不合法的文件不应被当成孤儿删除',
  );

  console.log('store assertions passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
