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
import { readStore, writeStore, writeSpaces, sortPages, mergeSpaces, storeExists, spacesIndexIsEmpty, recoverStore } from '../store.js';
import type { Database, Page, PageFileSnapshot } from '../store.js';

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
  /* ---- A fresh store is written and read back identically ---- */
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
  const deleteSnapshot = new Map<string, PageFileSnapshot>();
  readStore(dir, deleteSnapshot);
  writeStore(dir, db(page('alpha')), ['beta'], { expectedRemoved: deleteSnapshot });
  assert.equal(fs.existsSync(pageFile('beta')), false, '调用方声明的删除应移除对应文件');

  /* ---- A write that simply omits a page must NOT delete it ---- */
  // The incoming db is not an authoritative list of what should exist: a page whose file could
  // not be read is missing from it, and migration passes only the pages in its snapshot.
  // Treating that absence as "delete the file" destroyed user content (see recoverStore too).
  fs.writeFileSync(pageFile('kept'), '---\ntitle: 保留\nspace: default\n---\n\n正文\n', 'utf8');
  writeStore(dir, db(page('alpha')));
  assert.ok(fs.existsSync(pageFile('kept')), '未出现在 db 中的文件不应被当作孤儿删除');

  /* ---- Renaming a page moves the file when the old slug is declared ---- */
  const renameSnapshot = new Map<string, PageFileSnapshot>();
  readStore(dir, renameSnapshot);
  writeStore(dir, db(page('gamma')), ['alpha'], { expectedRemoved: renameSnapshot });
  assert.equal(fs.existsSync(pageFile('alpha')), false, '重命名后旧文件应消失');
  assert.equal(fs.existsSync(pageFile('gamma')), true, '重命名后应产生新文件');

  /* ---- A rename must not delete the new file when it reuses the old name ---- */
  writeStore(dir, db(page('keepname')), ['keepname']);
  assert.ok(fs.existsSync(pageFile('keepname')), '仍被使用的 slug 不应因声明删除而消失');

  /* ---- onlyCreate writes missing pages but never overwrites an existing one ---- */
  // Migration passes this so a stale snapshot cannot clobber a page file already on disk.
  // Contrast with a normal write below.
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

  /* ---- Ordinary saves preserve hand-written metadata and unrelated pages ---- */
  const preserveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-preserve-'));
  try {
    writeStore(preserveDir, db(page('edit'), page('other')));
    const editFile = path.join(preserveDir, 'pages', 'edit.md');
    const otherFile = path.join(preserveDir, 'pages', 'other.md');
    const original = '\uFEFF---\r\n# header\r\ntitle: Old # title comment\r\nspace: default\r\nparent: null\r\ncreatedAt: 1\r\nupdatedAt: 2\r\ncustom:\r\n  nested: [one, two] # custom comment\r\n---\r\n\r\nOld body\r\n';
    const other = '---\ntitle: Other\nspace: default\ncustom: keep # comment\n---\n\nOther body\n\n';
    fs.writeFileSync(editFile, original);
    fs.writeFileSync(otherFile, other);
    const snapshot = readStore(preserveDir);
    const edited = snapshot.pages.find(p => p.slug === 'edit')!;
    edited.title = 'New'; edited.parent = 'other'; edited.updatedAt = 3; edited.content = 'New body';
    writeStore(preserveDir, snapshot);
    const result = fs.readFileSync(editFile, 'utf8');
    assert.match(result, /# header\r\ntitle: "New" # title comment/);
    assert.match(result, /parent: "other"/);
    assert.match(result, /updatedAt: 3/);
    assert.match(result, /custom:\r\n  nested: \[one, two\] # custom comment/);
    assert.ok(result.endsWith('---\r\n\r\nNew body\n'));
    assert.equal(fs.readFileSync(otherFile, 'utf8'), other, '无关页面必须逐字节保留');
    assert.equal(readStore(preserveDir).pages.find(p => p.slug === 'edit')!.content, 'New body');

    // Missing known keys are inserted only when their effective values really change.
    const current = readStore(preserveDir);
    const otherPage = current.pages.find(p => p.slug === 'other')!;
    otherPage.parent = 'edit';
    writeStore(preserveDir, current);
    assert.match(fs.readFileSync(otherFile, 'utf8'), /custom: keep # comment\nparent: "edit"\n---/);
    assert.equal(readStore(preserveDir).pages.find(p => p.slug === 'other')!.parent, 'edit');

    const broken = '---\ntitle: [broken\ncustom: keep\n---\n\nBody\n';
    fs.writeFileSync(editFile, broken);
    const brokenDb = readStore(preserveDir);
    const brokenPage = brokenDb.pages.find(p => p.slug === 'edit')!;
    brokenPage.content = 'Revised';
    writeStore(preserveDir, brokenDb);
    assert.equal(fs.readFileSync(editFile, 'utf8'), broken.replace('Body\n', 'Revised\n'));
    const changedBroken = readStore(preserveDir);
    changedBroken.pages.find(p => p.slug === 'edit')!.title = 'Unsafe';
    assert.throws(() => writeStore(preserveDir, changedBroken), /front matter/);
    assert.equal(fs.readFileSync(editFile, 'utf8'), broken.replace('Body\n', 'Revised\n'));

    const alias = '---\ntitle: &name Hello\nspace: default\ncustom: *name\n---\n\nBody\n';
    fs.writeFileSync(editFile, alias);
    const aliasDb = readStore(preserveDir);
    aliasDb.pages.find(p => p.slug === 'edit')!.title = 'Changed';
    aliasDb.pages.find(p => p.slug === 'other')!.title = 'Also changed';
    const beforeRejected = fs.readFileSync(otherFile, 'utf8');
    assert.throws(() => writeStore(preserveDir, aliasDb), /锚点或别名/);
    assert.equal(fs.readFileSync(editFile, 'utf8'), alias);
    assert.equal(fs.readFileSync(otherFile, 'utf8'), beforeRejected, '拒绝不安全修改时不得先写入其他页面');

    const unclosed = '---\ntitle: unfinished\n';
    fs.writeFileSync(editFile, unclosed);
    const unclosedDb = readStore(preserveDir);
    assert.equal(unclosedDb.pages.find(p => p.slug === 'edit')!.unclosedFrontMatter, true, '未闭合的文件头应标记为不安全，供编辑器保护');
    unclosedDb.pages.find(p => p.slug === 'edit')!.content = 'changed';
    assert.throws(() => writeStore(preserveDir, unclosedDb), /结束围栏/);
    assert.equal(fs.readFileSync(editFile, 'utf8'), unclosed);

    fs.writeFileSync(editFile, '# Plain\n\nText\n');
    const plain = readStore(preserveDir);
    const plainPage = plain.pages.find(p => p.slug === 'edit')!;
    plainPage.content = '# Plain\n\nChanged';
    writeStore(preserveDir, plain);
    assert.equal(readStore(preserveDir).pages.find(p => p.slug === 'edit')!.content, '# Plain\n\nChanged');

    // A slug change is explicit so the source file's handwritten metadata follows the page.
    fs.writeFileSync(editFile, original);
    const renamedFiles = new Map<string, PageFileSnapshot>();
    const renamedDb = readStore(preserveDir, renamedFiles);
    const renamedPage = renamedDb.pages.find(p => p.slug === 'edit')!;
    renamedPage.slug = 'renamed'; renamedPage.updatedAt = 7;
    writeStore(preserveDir, renamedDb, ['edit'], { rename: { from: 'edit', to: 'renamed' }, expectedRemoved: renamedFiles });
    const renamedFile = path.join(preserveDir, 'pages', 'renamed.md');
    assert.equal(fs.existsSync(editFile), false);
    assert.match(fs.readFileSync(renamedFile, 'utf8'), /custom:\r\n  nested: \[one, two\] # custom comment/, '重命名应保留自定义元数据');
    assert.match(fs.readFileSync(renamedFile, 'utf8'), /title: Old # title comment/);
    assert.equal(readStore(preserveDir).pages.find(p => p.slug === 'renamed')!.updatedAt, 7);
  } finally { fs.rmSync(preserveDir, { recursive: true, force: true }); }

  /* ---- A save reads unchanged pages only once and rechecks changed files before writing. ---- */
  {
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-write-snapshot-'));
    try {
      writeStore(snapshotDir, db(page('first'), page('second'), page('third')));
      const target = path.join(snapshotDir, 'pages', 'first.md');
      const untouched = path.join(snapshotDir, 'pages', 'second.md');
      const other = path.join(snapshotDir, 'pages', 'third.md');
      const before = fs.readFileSync(untouched, 'utf8');
      const snapshot = readStore(snapshotDir);
      snapshot.pages.find(p => p.slug === 'first')!.content = '修改后的正文';
      const counts = new Map<string, number>();
      const originalRead = fs.readFileSync;
      const originalOpen = fs.openSync;
      const descriptorPaths = new Map<number, string>();
      const trackOpen = (file: fs.PathLike, ...args: unknown[]) => {
        const fd = (originalOpen as any)(file, ...args) as number;
        if (typeof file === 'string') descriptorPaths.set(fd, file);
        return fd;
      };
      const readPath = (file: fs.PathOrFileDescriptor) => typeof file === 'number' ? descriptorPaths.get(file) : file;
      try {
        (fs as any).openSync = trackOpen;
        (fs as any).readFileSync = (file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
          const name = readPath(file);
          if (typeof name === 'string' && name.startsWith(path.join(snapshotDir, 'pages') + path.sep)) {
            counts.set(name, (counts.get(name) || 0) + 1);
          }
          return (originalRead as any)(file, ...args);
        };
        writeStore(snapshotDir, snapshot);
      } finally { (fs as any).readFileSync = originalRead; (fs as any).openSync = originalOpen; }
      assert.equal(counts.get(target), 2, '修改页读取一次快照、一次冲突校验');
      assert.equal(counts.get(untouched), 1, '未修改页不应重复读取');
      assert.equal(counts.get(other), 1, '未修改页不应重复读取');
      assert.equal(fs.readFileSync(untouched, 'utf8'), before, '未修改页逐字节不变');

      const conflicted = readStore(snapshotDir);
      conflicted.pages.find(p => p.slug === 'first')!.content = '不能覆盖外部修改';
      const current = fs.readFileSync(target, 'utf8');
      let targetReads = 0;
      try {
        (fs as any).openSync = trackOpen;
        (fs as any).readFileSync = (file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
          const contents = (originalRead as any)(file, ...args);
          if (readPath(file) === target && ++targetReads === 2) return String(contents) + 'external change';
          return contents;
        };
        assert.throws(() => writeStore(snapshotDir, conflicted), /页面文件已变化/, '预检期间外部修改必须拒绝');
      } finally { (fs as any).readFileSync = originalRead; (fs as any).openSync = originalOpen; }
      assert.equal(fs.readFileSync(target, 'utf8'), current, '冲突时不得写入目标');
      assert.equal(fs.readFileSync(untouched, 'utf8'), before, '冲突时不得修改其他页面');

      try {
        (fs as any).readFileSync = (file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
          if (file === target) throw Object.assign(new Error('simulated read error'), { code: 'EACCES' });
          return (originalRead as any)(file, ...args);
        };
        assert.throws(() => writeStore(snapshotDir, conflicted), /无法读取页面/, '无法读取已有文件时不能覆盖');
      } finally { (fs as any).readFileSync = originalRead; }
      assert.equal(fs.readFileSync(target, 'utf8'), current, '读失败时目标必须原样保留');
      assert.equal(fs.readFileSync(untouched, 'utf8'), before, '读失败时不得修改其他页面');
    } finally { fs.rmSync(snapshotDir, { recursive: true, force: true }); }
  }

  /* ---- Deleted files are checked against the caller's snapshot and again before unlink. ---- */
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-delete-snapshot-'));
    const setup = (name: string) => {
      const fixture = path.join(root, name);
      writeStore(fixture, db(page('remove'), page('keep')));
      const snapshots = new Map<string, PageFileSnapshot>();
      const state = readStore(fixture, snapshots);
      const removedFile = path.join(fixture, 'pages', 'remove.md');
      const keepFile = path.join(fixture, 'pages', 'keep.md');
      return { fixture, snapshots, state, removedFile, keepFile };
    };
    try {
      // The external write happened after the request read but before writeStore's own snapshot.
      const early = setup('early');
      const keepBefore = fs.readFileSync(early.keepFile, 'utf8');
      const changed = fs.readFileSync(early.removedFile, 'utf8') + '\n外部修改\n';
      fs.writeFileSync(early.removedFile, changed);
      early.state.pages.find(p => p.slug === 'keep')!.title = '待写入';
      early.state.pages = early.state.pages.filter(p => p.slug !== 'remove');
      assert.throws(() => writeStore(early.fixture, early.state, ['remove']), /不在原始快照/, '直接调用也必须提供原始删除快照');
      assert.throws(() => writeStore(early.fixture, early.state, ['remove'], { expectedRemoved: early.snapshots }), /待删除页面已变化/, '请求读取后的外部修改不得被删除');
      assert.equal(fs.readFileSync(early.removedFile, 'utf8'), changed);
      assert.equal(fs.readFileSync(early.keepFile, 'utf8'), keepBefore, '删除预检失败时不得写入其他页面');

      // Same bytes in a different inode still represent a replaced file, not the one requested.
      const replaced = setup('replaced');
      const original = fs.readFileSync(replaced.removedFile, 'utf8');
      const replacement = path.join(replaced.fixture, 'replacement.md');
      fs.writeFileSync(replacement, original);
      fs.renameSync(replacement, replaced.removedFile);
      replaced.state.pages = replaced.state.pages.filter(p => p.slug !== 'remove');
      assert.throws(() => writeStore(replaced.fixture, replaced.state, ['remove'], { expectedRemoved: replaced.snapshots }), /待删除页面已变化/, '同内容的同名替换也不得误删');
      assert.equal(fs.readFileSync(replaced.removedFile, 'utf8'), original);

      // A replacement between reading content and recording identity must not create a torn snapshot.
      const torn = setup('torn');
      const tornReplacement = path.join(torn.fixture, 'replacement.md');
      fs.writeFileSync(tornReplacement, fs.readFileSync(torn.removedFile, 'utf8'));
      const originalOpen = fs.openSync;
      const originalFstat = fs.fstatSync;
      let targetFd = -1;
      let swapped = false;
      const tornFiles = new Map<string, PageFileSnapshot>();
      try {
        (fs as any).openSync = (file: fs.PathLike, ...args: unknown[]) => {
          const fd = (originalOpen as any)(file, ...args) as number;
          if (file === torn.removedFile) targetFd = fd;
          return fd;
        };
        (fs as any).fstatSync = (fd: number, ...args: unknown[]) => {
          const stat = (originalFstat as any)(fd, ...args);
          if (fd === targetFd && !swapped) { fs.renameSync(tornReplacement, torn.removedFile); swapped = true; }
          return stat;
        };
        readStore(torn.fixture, tornFiles);
      } finally { (fs as any).openSync = originalOpen; (fs as any).fstatSync = originalFstat; }
      assert.equal(swapped, true, '测试应确实发生文件替换');
      assert.equal(tornFiles.has('remove'), false, '被替换的文件不能形成混合内容和身份的快照');
      torn.state.pages = torn.state.pages.filter(p => p.slug !== 'remove');
      assert.throws(() => writeStore(torn.fixture, torn.state, ['remove'], { expectedRemoved: tornFiles }), /不在原始快照/);
      assert.equal(fs.existsSync(torn.removedFile), true, '读取期间替换的新文件必须保留');

      // If a rename source changes after the new file is installed, keep both and report partial work.
      const late = setup('late');
      const sourceBefore = fs.readFileSync(late.removedFile, 'utf8');
      const targetFile = path.join(late.fixture, 'pages', 'renamed.md');
      late.state.pages.find(p => p.slug === 'remove')!.slug = 'renamed';
      const originalRename = fs.renameSync;
      try {
        (fs as any).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
          originalRename(from, to);
          if (to === targetFile) fs.writeFileSync(late.removedFile, sourceBefore + '\n外部修改\n');
        };
        assert.throws(() => writeStore(late.fixture, late.state, ['remove'], {
          rename: { from: 'remove', to: 'renamed' }, expectedRemoved: late.snapshots,
        }), /部分更改可能已写入/, '后期冲突应说明重命名可能部分完成');
      } finally { (fs as any).renameSync = originalRename; }
      assert.match(fs.readFileSync(late.removedFile, 'utf8'), /外部修改/, '必须保留外部修改的旧文件');
      assert.equal(fs.existsSync(targetFile), true, '不得悄悄删除已经写入的新文件');

      const denied = setup('denied');
      denied.state.pages = denied.state.pages.filter(p => p.slug !== 'remove');
      const originalUnlink = fs.unlinkSync;
      try {
        (fs as any).unlinkSync = (file: fs.PathLike) => {
          if (file === denied.removedFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return originalUnlink(file);
        };
        assert.throws(() => writeStore(denied.fixture, denied.state, ['remove'], { expectedRemoved: denied.snapshots }), /无法删除页面/, '删除失败不能报告成功');
      } finally { (fs as any).unlinkSync = originalUnlink; }
      assert.equal(fs.existsSync(denied.removedFile), true);
      assert.throws(() => writeStore(denied.fixture, denied.state, ['remove'], { onlyCreate: true }), /仅创建模式不能删除/);
      const deniedOpen = fs.openSync;
      try {
        (fs as any).openSync = (file: fs.PathLike, ...args: unknown[]) => {
          if (file === denied.removedFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return (deniedOpen as any)(file, ...args);
        };
        assert.throws(() => writeStore(denied.fixture, denied.state, ['remove'], { expectedRemoved: denied.snapshots }), /待删除页面已变化或无法读取/, '不可读文件不能删除');
      } finally { (fs as any).openSync = deniedOpen; }
      assert.equal(fs.existsSync(denied.removedFile), true);

      const partial = setup('partial');
      partial.state.pages = [];
      try {
        (fs as any).unlinkSync = (file: fs.PathLike) => {
          if (file === partial.keepFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return originalUnlink(file);
        };
        assert.throws(() => writeStore(partial.fixture, partial.state, ['remove', 'keep'], { expectedRemoved: partial.snapshots }), /部分更改可能已写入/, '部分删除后出错不得声称全部成功');
      } finally { (fs as any).unlinkSync = originalUnlink; }
      assert.equal(fs.existsSync(partial.removedFile), false, '先前成功的删除不会被虚假回滚');
      assert.equal(fs.existsSync(partial.keepFile), true, '失败的删除必须保留原文件');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

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

  /* ---- A lost spaces.json is rebuilt from the existing pages ---- */
  // The pages directory is the source of truth; recovery must leave its files untouched.
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

    // An empty directory is not a recovery case; startup initializes an empty user store.
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

  /* ---- Page order is derived from page data, never from directory order ---- */
  // `readdirSync` is creation order only on small ext4 directories and hash order on APFS/NTFS or
  // once the directory gains an htree, so a sidebar built on it can reshuffle unpredictably. The
  // order must come from the pages themselves, and each space must respect its own key.
  const ordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-store-ord-'));
  const p3 = (slug: string, createdAt: number, updatedAt: number, space = 'default', title = slug) =>
    page(slug, { space, title, createdAt, updatedAt });
  writeSpaces(ordDir, [
    { slug: 'default', title: 'D', desc: '', home: null, createdAt: 1, updatedAt: 1 },
    { slug: 'team', title: 'T', desc: '', home: null, sort: 'created_asc', createdAt: 1, updatedAt: 1 },
  ]);
  // Written in an order chosen so the answer cannot coincide with directory order.
  writeStore(ordDir, {
    version: 4,
    spaces: [
      { slug: 'default', title: 'D', desc: '', home: null, createdAt: 1, updatedAt: 1 },
      { slug: 'team', title: 'T', desc: '', home: null, sort: 'created_asc', createdAt: 1, updatedAt: 1 },
    ],
    pages: [
      p3('b', 10, 100),
      p3('a', 20, 50),
      p3('c', 30, 10),
      p3('x', 5, 5, 'team'),
      p3('y', 7, 7, 'team'),
    ],
  });
  const ordered = readStore(ordDir);
  assert.deepEqual(
    ordered.pages.filter(p => p.space === 'default').map(p => p.slug),
    ['c', 'a', 'b'],
    '默认空间应按 createdAt 降序（最新在前）',
  );
  assert.deepEqual(
    ordered.pages.filter(p => p.space === 'team').map(p => p.slug),
    ['x', 'y'],
    '空间自己的 sort 应生效，而非所有空间共用一种顺序',
  );

  // A hand-edited index can hold anything; an unusable key must be dropped, not left in place —
  // an unknown value matches no comparator and would silently leave that space unordered.
  const idxPath = path.join(ordDir, 'spaces.json');
  const rawIdx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  rawIdx.spaces[0].sort = 'garbage';
  fs.writeFileSync(idxPath, JSON.stringify(rawIdx, null, 2) + '\n', 'utf8');
  const cleaned = readStore(ordDir);
  assert.equal(cleaned.spaces[0].sort, undefined, '非法的 sort 值应被丢弃');
  assert.deepEqual(
    cleaned.pages.filter(p => p.space === 'default').map(p => p.slug),
    ['c', 'a', 'b'],
    '丢弃非法值后应回到默认排序，而不是目录序',
  );

  // Ties are broken by slug so the result is a total order, not whatever the sort happened to do.
  const tied = sortPages([p3('z', 5, 5), p3('m', 5, 5), p3('a', 5, 5)]);
  assert.deepEqual(tied.map(p => p.slug), ['a', 'm', 'z'], '时间戳相同时应按 slug 定序');
  fs.rmSync(ordDir, { recursive: true, force: true });

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
