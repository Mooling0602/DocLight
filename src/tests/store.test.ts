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
import { readStore, writeStore, writeSpaces, mergeSpaces, storeExists, spacesIndexIsEmpty, recoverStore } from '../store.js';
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

  /* ---- Deleting a page removes its file, but only when the caller says so ---- */
  writeStore(dir, db(page('alpha')), ['beta']);
  assert.equal(fs.existsSync(pageFile('beta')), false, '调用方声明的删除应移除对应文件');

  /* ---- A write that simply omits a page must NOT delete it ---- */
  // The incoming db is not an authoritative list of what should exist: a page whose file could
  // not be read is missing from it, and seeding/migration pass only the pages they were given.
  // Treating that absence as "delete the file" destroyed user content (see recoverStore too).
  fs.writeFileSync(pageFile('kept'), '---\ntitle: 保留\nspace: default\n---\n\n正文\n', 'utf8');
  writeStore(dir, db(page('alpha')));
  assert.ok(fs.existsSync(pageFile('kept')), '未出现在 db 中的文件不应被当作孤儿删除');

  /* ---- Renaming a page moves the file when the old slug is declared ---- */
  writeStore(dir, db(page('gamma')), ['alpha']);
  assert.equal(fs.existsSync(pageFile('alpha')), false, '重命名后旧文件应消失');
  assert.equal(fs.existsSync(pageFile('gamma')), true, '重命名后应产生新文件');

  /* ---- A rename must not delete the new file when it reuses the old name ---- */
  writeStore(dir, db(page('keepname')), ['keepname']);
  assert.ok(fs.existsSync(pageFile('keepname')), '仍被使用的 slug 不应因声明删除而消失');

  /* ---- onlyCreate writes missing pages but never overwrites an existing one ---- */
  // Migration and seeding pass this so a store they are establishing cannot clobber a page file
  // that is already there (the stale re-import case). Contrast with a normal write below.
  fs.writeFileSync(pageFile('live'), '---\ntitle: 用户改过的\nspace: default\n---\n\n# 用户改过的\n', 'utf8');
  writeStore(dir, db(page('live', { content: '# 来自旧快照\n' }), page('added')), [], { onlyCreate: true });
  assert.match(fs.readFileSync(pageFile('live'), 'utf8'), /用户改过的/, 'onlyCreate 不得覆盖已存在的页面');
  assert.ok(fs.existsSync(pageFile('added')), 'onlyCreate 仍应补建缺失的页面');

  // Without the flag the same write does update the file, proving the option is what protected it.
  writeStore(dir, db(page('live', { content: '# 普通写入\n' })));
  assert.match(fs.readFileSync(pageFile('live'), 'utf8'), /普通写入/, '普通写入应更新已存在的页面');

  /* ---- onlyCreate must protect the spaces index too, not just the page files ---- */
  // A space's title/description live *only* in `spaces.json` (the page front matter records which
  // space a page belongs to, never what the space is called). A snapshot carried by a re-migration
  // therefore cannot be allowed to overwrite a live index, or the user's renamed space reverts.
  const idxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-idx-'));
  writeStore(idxDir, db(page('mine')));
  const liveIndex = {
    version: 4,
    spaces: [
      { slug: 'default', title: '用户改过的空间名', desc: '用户改过的描述', home: null, createdAt: 1, updatedAt: 2 },
      { slug: 'team', title: '团队空间', desc: '内部资料', home: null, createdAt: 3, updatedAt: 4 },
    ],
  };
  fs.writeFileSync(path.join(idxDir, 'spaces.json'), JSON.stringify(liveIndex, null, 2) + '\n', 'utf8');
  writeStore(idxDir, db(page('mine')), [], { onlyCreate: true });
  const kept = JSON.parse(fs.readFileSync(path.join(idxDir, 'spaces.json'), 'utf8'));
  assert.equal(kept.spaces[0].title, '用户改过的空间名', 'onlyCreate 不得覆盖已存在的空间元数据');
  assert.deepEqual(kept.spaces.map((s: any) => s.slug), ['default', 'team'], 'onlyCreate 不得丢掉用户自建的空间');

  // A malformed index is not live data, so it must still be repaired rather than preserved.
  fs.writeFileSync(path.join(idxDir, 'spaces.json'), '', 'utf8');
  writeStore(idxDir, db(page('mine')), [], { onlyCreate: true });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(idxDir, 'spaces.json'), 'utf8')).spaces[0].slug,
    'default',
    '损坏的索引仍应被修复',
  );

  // An index naming no spaces is equally unusable — it cannot classify a single page — so a write
  // that establishes the store must be allowed to fill it in.
  fs.writeFileSync(path.join(idxDir, 'spaces.json'), '{"version":4,"spaces":[]}', 'utf8');
  writeStore(idxDir, db(page('mine')), [], { onlyCreate: true });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(idxDir, 'spaces.json'), 'utf8')).spaces.map((s: any) => s.slug),
    ['default'],
    '空索引在 onlyCreate 下仍应被写入',
  );
  fs.rmSync(idxDir, { recursive: true, force: true });

  /* ---- mergeSpaces keeps the snapshot's order and appends the spaces it cannot know about ---- */
  // Used by the migration path: the snapshot names the spaces as of the export, while the page
  // files may name one the user created later. Both must survive, and the snapshot wins a clash.
  const snapshot = [{ slug: 'default', title: '快照名', desc: '', home: null, createdAt: 1, updatedAt: 2 }];
  const fromDisk = [
    { slug: 'team', title: '团队', desc: '内部', home: null, createdAt: 3, updatedAt: 4 },
    { slug: 'default', title: '磁盘名', desc: '不应生效', home: null, createdAt: 5, updatedAt: 6 },
  ];
  const merged = mergeSpaces(snapshot, fromDisk);
  assert.deepEqual(merged.map(s => s.slug), ['default', 'team'], '合并应保留快照顺序并补上磁盘空间');
  assert.equal(merged[0].title, '快照名', '同名空间应以快照为准');
  assert.equal(merged[1].title, '团队', '磁盘独有的空间应被补入');

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

  /* ---- A lost spaces.json is rebuilt from the pages, never overwritten by the sample ---- */
  // Seeding here would replace every page whose name collides with a sample page, so the
  // pages directory is the source of truth whenever it holds anything.
  {
    const lost = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-lost-'));
    fs.mkdirSync(path.join(lost, 'pages'), { recursive: true });
    fs.writeFileSync(
      path.join(lost, 'pages', 'mine.md'),
      '---\ntitle: 我的文档\nspace: team\n---\n\n重要内容\n',
      'utf8',
    );
    assert.equal(storeExists(lost), false, '缺少 spaces.json 时不应视为已初始化');

    const restored = recoverStore(lost)!;
    assert.ok(restored, '存在页面文件时应能从磁盘恢复索引');
    assert.equal(restored.pages.length, 1, '恢复应保留既有页面');
    assert.equal(restored.pages[0].title, '我的文档', '恢复应保留 front matter 中的标题');
    assert.equal(restored.pages[0].space, 'team', '空间应取自 front matter 而非回退默认值');
    assert.deepEqual(restored.spaces.map(s => s.slug), ['team'], '应为每个出现过的空间建索引');

    // Recovery writes only the index, so the page file stays byte-for-byte as the user left it.
    const before = fs.readFileSync(path.join(lost, 'pages', 'mine.md'), 'utf8');
    writeSpaces(lost, restored.spaces);
    assert.equal(fs.readFileSync(path.join(lost, 'pages', 'mine.md'), 'utf8'), before, '恢复不应改写页面文件');
    assert.equal(storeExists(lost), true, '恢复后应写回 spaces.json');

    // An empty directory is not a recovery case — that is the normal first-run seeding path.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-empty-'));
    assert.equal(recoverStore(empty), null, '没有任何页面时不应走恢复路径');

    // An unusable space name is not minted into a bogus space: it falls back, and because a
    // page now lives in `default`, that space is created.
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-odd-'));
    fs.mkdirSync(path.join(odd, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(odd, 'pages', 'x.md'), '---\ntitle: X\nspace: Bad Name\n---\n\n正文\n', 'utf8');
    const oddRestored = recoverStore(odd)!;
    assert.deepEqual(oddRestored.spaces.map(s => s.slug), ['default'], '非法空间名应回退而不是新建');
    assert.equal(oddRestored.pages[0].space, 'default', '回退后的页面应属于 default');

    // A top-level page is preferred as the space home so readers are not dropped onto a child.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-home-'));
    fs.mkdirSync(path.join(home, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(home, 'pages', 'child.md'), '---\ntitle: 子页\nspace: s\nparent: parent\n---\n\n子\n', 'utf8');
    fs.writeFileSync(path.join(home, 'pages', 'parent.md'), '---\ntitle: 父页\nspace: s\n---\n\n父\n', 'utf8');
    const homeRestored = recoverStore(home)!;
    assert.equal(homeRestored.spaces[0].home, 'parent', '空间首页应优先取顶层页面');

    /* ---- A truncated index counts as missing, so it is repaired rather than trusted ---- */
    const truncated = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-trunc-'));
    fs.mkdirSync(path.join(truncated, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(truncated, 'pages', 'p.md'), '---\ntitle: P\nspace: s\n---\n\n正文\n', 'utf8');
    fs.writeFileSync(path.join(truncated, 'spaces.json'), '', 'utf8');
    assert.equal(storeExists(truncated), false, '空/损坏的 spaces.json 应视为未初始化');

    /* ---- An index that parses but names no spaces is detected as unusable ---- */
    // It passes the parse/shape test, yet readStore has no valid slug to fall back to and would
    // collapse every page onto 'default', persisting that loss on the next write. Startup must be
    // able to tell this apart from a healthy index, and from a site the user emptied on purpose.
    const blankIdx = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-blankidx-'));
    fs.mkdirSync(path.join(blankIdx, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(blankIdx, 'pages', 'p.md'), '---\ntitle: P\nspace: myspace\n---\n\n正文\n', 'utf8');
    fs.writeFileSync(path.join(blankIdx, 'spaces.json'), '{"version":4,"spaces":[]}', 'utf8');
    assert.equal(storeExists(blankIdx), true, '空数组索引能解析，故 storeExists 仍为真');
    assert.equal(spacesIndexIsEmpty(blankIdx), true, '空索引应被识别为不可用');

    // A healthy index and a missing one are both "not empty".
    fs.writeFileSync(
      path.join(blankIdx, 'spaces.json'),
      '{"version":4,"spaces":[{"slug":"s","title":"S","desc":"","home":null,"createdAt":1,"updatedAt":1}]}',
      'utf8',
    );
    assert.equal(spacesIndexIsEmpty(blankIdx), false, '含空间时不应判为空');
    fs.rmSync(path.join(blankIdx, 'spaces.json'));
    assert.equal(spacesIndexIsEmpty(blankIdx), false, '索引缺失应由 storeExists 处理，而非此判据');

    // Recovery from the pages restores the real space name instead of collapsing it.
    fs.writeFileSync(path.join(blankIdx, 'spaces.json'), '{"version":4,"spaces":[]}', 'utf8');
    const fromBlank = recoverStore(blankIdx)!;
    assert.deepEqual(fromBlank.spaces.map(s => s.slug), ['myspace'], '应按页面重建出真实空间名');

    fs.rmSync(lost, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(odd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(truncated, { recursive: true, force: true });
    fs.rmSync(blankIdx, { recursive: true, force: true });
  }

  /* ---- An unsafe slug never reaches the filesystem ---- */
  // A page slug becomes a file name, so a value like `../../x` would write outside `pages/` — to a
  // path no later read can find, under whatever identity the service runs as. The legacy migration
  // is where slugs the programme did not mint itself arrive, but the guard lives in `writeStore`
  // because that is the only place a file is actually created, covering every caller.
  const unsafeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-unsafe-'));
  const unsafeDir = path.join(unsafeParent, 'data');
  writeStore(unsafeDir, db(
    page('safe'),
    page('../escaped'),
    page('../../escaped'),
    page('sub/dir'),
    page('UPPER'),
  ));
  // `../escaped` would land beside the data directory, `../../escaped` one level above that.
  assert.ok(!fs.existsSync(path.join(unsafeParent, 'escaped.md')), '越界 slug 不得写出数据目录之外');
  assert.ok(
    !fs.existsSync(path.join(path.dirname(unsafeParent), 'escaped.md')),
    '越界 slug 不得写到更上一层',
  );
  assert.deepEqual(
    fs.readdirSync(path.join(unsafeDir, 'pages')).sort(),
    ['safe.md'],
    '只应写出 slug 合法的页面',
  );
  // An unsafe slug cannot be used to unlink a file outside `pages/` either.
  const outside = path.join(unsafeParent, 'victim.md');
  fs.writeFileSync(outside, '不该被删\n', 'utf8');
  writeStore(unsafeDir, db(page('safe')), ['../victim']);
  assert.ok(fs.existsSync(outside), '越界 slug 也不得用于删除 pages/ 之外的文件');
  fs.rmSync(unsafeParent, { recursive: true, force: true });

  console.log('store assertions passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
