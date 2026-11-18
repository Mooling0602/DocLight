/*
 * GitHub callout (alert) support: `> [!NOTE]` plus TIP / IMPORTANT / WARNING / CAUTION.
 *
 * Three properties matter:
 *   1. The reading view renders a labelled card with an icon instead of a plain quote;
 *   2. The browser sanitizer (DOMPurify) keeps that generated markup;
 *   3. The visual editor serialises the card back to the original blockquote, so opening
 *      and saving a page never rewrites hand-written Markdown.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { CALLOUT_TYPES, htmlToMarkdown, markdownToHtml } from '../markdown.js';

const purify = createDOMPurify(
  new JSDOM('<!doctype html><body></body>').window as unknown as Parameters<typeof createDOMPurify>[0],
);

/** What the reading view inserts into the DOM: rendered, then sanitised like the client does. */
const render = (markdown: string): string => purify.sanitize(markdownToHtml(markdown));
/** What the editor stores on save: render, sanitize, convert back to Markdown. */
const roundTrip = (markdown: string): string => htmlToMarkdown(render(markdown));

const LABELS: Record<string, string> = {
  note: '注意', tip: '提示', important: '重要', warning: '警告', caution: '危险',
};

// Every type maps to its own class and localised title; the marker never reaches the page.
for (const type of CALLOUT_TYPES) {
  const marker = `> [!${type.toUpperCase()}]`;
  const html = render(`${marker}\n> 正文`);
  assert.match(html, new RegExp(`class="callout callout-${type}"`), `${type}: 应渲染为对应类型的卡片`);
  assert.match(html, new RegExp(`<span>${LABELS[type]}</span>`), `${type}: 标题应使用本地化文案`);
  assert.match(html, /<svg class="callout-icon"/, `${type}: 标题应带图标`);
  assert.ok(!html.includes(marker), `${type}: 标记不应出现在结果里`);
  assert.match(html, /<p>正文<\/p>/, `${type}: 正文仍应正常渲染`);
  assert.equal(roundTrip(`${marker}\n> 正文`), `${marker}\n> 正文`, `${type}: 往返应保持源码`);
}

// The client sanitises everything it renders; the card and its SVG icon must survive that.
{
  const html = render('> [!NOTE]\n> 正文');
  assert.match(html, /<svg/, '图标在净化后应保留');
  assert.match(html, /<path d="/, '图标路径在净化后应保留');
}

// Inline formatting inside a callout is ordinary Markdown.
{
  const source = '> [!TIP]\n> **加粗**、`代码` 与 [链接](https://example.com)';
  const html = render(source);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<code>代码<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.equal(roundTrip(source), source);
}

// A quoted blank line starts a second paragraph instead of ending the callout.
{
  const source = '> [!NOTE]\n> 第一段\n>\n> 第二段';
  const html = render(source);
  assert.equal((html.match(/<p>/g) || []).length, 2, '空白引用行应分隔两个段落');
  assert.equal(roundTrip(source), source);
}

// Block constructs keep working inside the card.
{
  const source = '> [!WARNING]\n> - 甲\n> - 乙';
  assert.match(render(source), /<ul>[\s\S]*<li>甲<\/li>/);
  assert.equal(roundTrip(source), source);
}

// The token stops at the blockquote boundary: a following paragraph stays outside the card.
{
  const source = '> [!NOTE]\n> 卡片\n\n卡片外的段落';
  const html = render(source);
  assert.match(html, /^<div class="callout callout-note">/);
  assert.match(html, /<\/div>\n<p>卡片外的段落<\/p>/);
  assert.equal(roundTrip(source), source);
}

// GitHub allows lazy continuation lines inside a blockquote until a real block boundary.
{
  const source = '> [!NOTE]\n> 第一行\n继续正文\n\n卡片外的段落';
  const doc = new JSDOM(render(source)).window.document;
  const card = doc.querySelector('.callout-note')!;
  assert.match(card.textContent || '', /第一行\s+继续正文/, '没有引用前缀的延续行仍属于标注块');
  assert.equal(card.nextElementSibling?.textContent, '卡片外的段落', '空行后的段落仍在标注块之外');
  const saved = roundTrip(source);
  assert.match(saved, /> 第一行\s+继续正文/, '可视化保存时延续内容仍属于引用');
  assert.equal(roundTrip(saved), saved, '规范化后的源码再次保存应稳定');
  const heading = new JSDOM(render('> [!TIP]\n> 内容\n# 外部标题')).window.document;
  assert.equal(heading.querySelector('.callout-tip')?.nextElementSibling?.tagName, 'H1', '标题应终止延续行');
  const outsideList = new JSDOM(render('> [!NOTE]\n> 内容\n- 外部列表')).window.document;
  assert.equal(outsideList.querySelector('.callout-note')?.nextElementSibling?.tagName, 'UL', '未引用的列表应终止标注块');
  const outsideCode = new JSDOM(render('> [!TIP]\n> 内容\n```js\ncode\n```')).window.document;
  assert.equal(outsideCode.querySelector('.callout-tip')?.nextElementSibling?.tagName, 'PRE', '未引用的围栏代码块应终止标注块');
  const list = new JSDOM(render('> [!WARNING]\n> - 列表项\n延续文本')).window.document;
  assert.match(list.querySelector('.callout-warning li')?.textContent || '', /列表项\s+延续文本/, '列表项的延续行应留在标注块内');
}

// The marker is case-insensitive; saving normalises it to upper case.
{
  assert.match(render('> [!note]\n> 正文'), /class="callout callout-note"/);
  assert.equal(roundTrip('> [!note]\n> 正文'), '> [!NOTE]\n> 正文');
}

// Not callouts: text after the marker on its line, or the marker anywhere but the first line.
{
  const plain = render('> [!NOTE] 这是普通引用');
  assert.ok(!plain.includes('class="callout'), '标记后带正文时应保持普通引用');
  assert.match(plain, /<blockquote>/);
  assert.ok(plain.includes('[!NOTE] 这是普通引用'));
}
assert.ok(!render('> 前言\n> [!NOTE]\n> 内容').includes('class="callout'), '标记不在首行时应保持普通引用');

// Unknown types stay plain quotes and keep their text (turndown escapes the brackets, which
// is ordinary Markdown text handling — the point is that no card is produced).
{
  const html = render('> [!DANGER]\n> 未知类型');
  assert.ok(!html.includes('class="callout'), '未知类型不应渲染成卡片');
  assert.ok(html.includes('[!DANGER]'));
  assert.equal(roundTrip(roundTrip('> [!DANGER]\n> 未知类型')), roundTrip('> [!DANGER]\n> 未知类型'));
}

// Inside a code fence the syntax is sample text, not a callout.
{
  const source = '```\n> [!NOTE]\n> 不是标注\n```';
  const html = render(source);
  assert.ok(!html.includes('class="callout'), '代码块里的标记不应渲染成卡片');
  assert.match(html, /<code>/);
  assert.equal(roundTrip(source), source);
}

// An empty callout keeps only its title, and still round-trips.
{
  const html = render('> [!NOTE]');
  assert.match(html, /class="callout callout-note"/);
  assert.match(html, /<span>注意<\/span>/);
  assert.equal(roundTrip('> [!NOTE]'), '> [!NOTE]');
}

// The title is generated, so a hostile body must not inject markup through it.
{
  const html = render('> [!CAUTION]\n> <img src=x onerror="window.pwned=1">');
  assert.ok(!html.includes('onerror'), '事件属性应被净化');
}

// Idempotency: repeated open-and-save cycles must not churn the file.
for (const source of [
  '> [!NOTE]\n> 一\n>\n> 二\n> - 列表',
  '> [!IMPORTANT]\n> ### 小标题\n> 正文',
]) {
  const once = roundTrip(source);
  assert.equal(roundTrip(once), once, '二次往返应稳定');
}

/* ---------------------------------------- alerts nested inside a list item (WYSIWYG save)
   GitHub lets an alert follow an item's own text as a nested block: the marker sits on its
   own quoted line under the item, the card belongs to that <li>, and the items after it stay
   siblings of the same list. Surrounding paragraphs stay outside the list.

   The visual editor rewrites the stored Markdown on every save, so three properties matter
   here: the marker must not be glued to the item text (that turns the card back into a plain
   quote on the next render), the rendered page must be identical after a save, and a second
   save must reproduce the first byte for byte — otherwise the file grows whitespace forever. */
{
  interface CardShape {
    className: string;
    /** Index of the list that owns the item, in document order. */
    list: number;
    /** Index of the item inside that list. */
    item: number;
    /** How many list levels the item is nested under. */
    depth: number;
    /** Card text without the generated title. */
    body: string;
  }
  interface PageShape {
    /** Top-level blocks, with paragraphs reduced to their text. */
    blocks: string[];
    /** Every list item as `depth:text`. */
    items: string[];
    cards: CardShape[];
  }

  /** Whitespace is layout, not content: compare the rendered page without it. */
  const squash = (value: string | null): string => (value || '').replace(/\s+/g, '');

  const shape = (html: string): PageShape => {
    const doc = new JSDOM(html).window.document;
    const lists = Array.from(doc.querySelectorAll('ul, ol'));
    const depthOf = (node: Element): number => {
      let depth = 0;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches('li')) depth += 1;
      }
      return depth;
    };
    const cards = Array.from(doc.querySelectorAll('.callout')).map((card) => {
      const body = card.cloneNode(true) as Element;
      const title = body.querySelector('.callout-title');
      if (title) title.remove();
      const item = card.closest('li');
      const parent = item ? item.parentElement : null;
      return {
        className: card.className,
        list: parent ? lists.indexOf(parent) : -1,
        item: parent ? Array.from(parent.children).indexOf(item as Element) : -1,
        depth: item ? depthOf(item) : -1,
        body: squash(body.textContent),
      };
    });
    return {
      blocks: Array.from(doc.body.children).map((block) => (block.matches('ul, ol')
        ? block.tagName.toLowerCase()
        : `${block.tagName.toLowerCase()}:${squash(block.textContent)}`)),
      items: Array.from(doc.querySelectorAll('li')).map((item) => `${depthOf(item)}:${squash(item.textContent)}`),
      cards,
    };
  };

  /** A marker line may carry list indentation and quote prefixes only — never item text. */
  const markerStandsAlone = (markdown: string, type: string): boolean => {
    const marker = `[!${type.toUpperCase()}]`;
    return markdown.split('\n').every((line) => !line.includes(marker)
      || /^[ \t]*(?:[-*+]|\d+\.)?[ \t]*(?:>[ \t]?)*\[![A-Z]+\][ \t]*$/.test(line));
  };

  const nested: Array<{ name: string; type: string; source: string }> = [
    {
      name: '无序列表：条目正文后嵌套标注块，后续同级条目仍在同一列表',
      type: 'note',
      source: '- 列表项\n  > [!NOTE]\n  > 正文\n- 后续项',
    },
    {
      name: '有序列表：条目正文后嵌套标注块，后续同级条目仍在同一列表',
      type: 'tip',
      source: '1. 第一项\n   > [!TIP]\n   > 提示正文\n2. 第二项\n3. 第三项',
    },
    {
      name: '松散条目：标注块前后的段落都留在条目内',
      type: 'warning',
      source: '- 前置说明\n\n  > [!WARNING]\n  > 警告正文\n\n  尾部说明\n- 后续项',
    },
    {
      name: '列表前后的段落不属于列表',
      type: 'note',
      source: '引言段落\n\n- 甲\n  > [!NOTE]\n  > 内\n- 乙\n\n收尾段落',
    },
    {
      name: '标注块位于中间条目时，前后条目都是同级',
      type: 'caution',
      source: '- 甲\n- 乙\n  > [!CAUTION]\n  > 内\n- 丙',
    },
    {
      name: '嵌套列表中的标注块仍属于最内层条目',
      type: 'note',
      source: '- 甲\n  - 子项\n    > [!NOTE]\n    > 内\n- 乙',
    },
    {
      name: '标注块内的列表不应破坏外层条目',
      type: 'tip',
      source: '- 甲\n  > [!TIP]\n  > - 子项一\n  > - 子项二\n- 乙',
    },
    {
      name: '同级条目的子列表与标注块一次保存后稳定',
      type: 'note',
      source: '- 甲\n  - 子一\n  - 子二\n- 乙\n  > [!NOTE]\n  > 内',
    },
    {
      name: '有序列表的同级子列表与标注块一次保存后稳定',
      type: 'tip',
      source: '3. 甲\n   1. 子一\n   2. 子二\n4. 乙\n   > [!TIP]\n   > 内',
    },
    {
      name: '任务列表中的标注块与复选框保持稳定',
      type: 'note',
      source: '- [x] 已完成\n  > [!NOTE]\n  > 提示\n- [ ] 未完成',
    },
  ];

  for (const { name, type, source } of nested) {
    const marker = `> [!${type.toUpperCase()}]`;
    const html = render(source);
    const before = shape(html);

    // The card is rendered inside the item, not floated out of the list.
    assert.equal(before.cards.length, 1, `${name}：应渲染出一个标注块`);
    assert.equal(before.cards[0].className, `callout callout-${type}`, `${name}：卡片应使用对应类型`);
    assert.ok(before.cards[0].item >= 0 && before.cards[0].depth >= 0, `${name}：标注块应在列表条目内渲染`);
    assert.ok(html.includes(`<span>${LABELS[type]}</span>`), `${name}：标题应使用本地化文案`);
    assert.ok(!html.includes(marker), `${name}：标记不应出现在结果里`);

    // One save keeps the marker on its own line, inside the same item, and the same page.
    const saved = roundTrip(source);
    assert.ok(saved.includes(marker), `${name}：一次保存应保留标记`);
    assert.ok(markerStandsAlone(saved, type), `${name}：标记应独占一行，不能与条目正文粘连`);
    assert.match(
      saved,
      new RegExp(`^[ \\t]+(?:>[ \\t]?)*\\[!${type.toUpperCase()}\\][ \\t]*$`, 'm'),
      `${name}：标记应保留条目缩进，不能被提到列表外`,
    );
    assert.ok(!saved.includes('\\[!'), `${name}：保存不应把标记转义成普通文本`);
    assert.deepEqual(shape(render(saved)), before, `${name}：一次保存不应改变渲染结果`);

    // A second save must be a no-op, byte for byte: the editor rewrites on every save.
    const twice = roundTrip(saved);
    assert.deepEqual(shape(render(twice)), before, `${name}：二次保存不应改变渲染结果`);
    assert.equal(twice, saved, `${name}：二次保存应与一次保存逐字节一致`);
  }
}

// Invalid HTML list starts must not turn the list and its callout into plain text.
{
  const card = '<div class="callout callout-note"><div class="callout-title">注意</div><p>内</p></div>';
  for (const start of ['x', '1.5', 'Infinity', '999999999999999999999']) {
    const saved = htmlToMarkdown(`<ol start="${start}"><li>甲</li><li>乙${card}</li></ol>`);
    assert.match(saved, /^1\. 甲/, `${start}: 无效起始值应回退到 1`);
    assert.equal(new JSDOM(render(saved)).window.document.querySelectorAll('ol > li').length, 2);
    assert.equal(new JSDOM(render(saved)).window.document.querySelectorAll('.callout-note').length, 1);
    assert.equal(roundTrip(saved), saved);
  }
}

/* ---------------------------------------------------- visual parity with GitHub
   The card deliberately imitates GitHub's `.markdown-alert` CSS: a 4px coloured left bar,
   no background, no rounded corners, a 500-weight coloured title and an 8px icon gap.
   Colours are GitHub's Primer tokens, so a page looks the same when the Markdown is pasted
   into a README. Asserting the declarations keeps a future restyle from drifting silently. */
{
  const root = path.resolve(__dirname, '../..');
  const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(match, `${selector} 规则应存在于 style.css`);
    return match![1];
  };

  // Saving a formerly tight list wraps item labels in paragraphs. The scoped CSS must keep
  // those new wrappers from introducing extra outer margins without changing ordinary lists.
  const savedList = roundTrip('- 甲\n- 乙\n  > [!NOTE]\n  > 内');
  const doc = new JSDOM(`<style>${css}</style><div class="article">${render(savedList)}<ul><li><p>普通</p></li></ul></div>`);
  const labels = doc.window.document.querySelectorAll('.article > ul:first-child > li > p');
  assert.equal(labels.length, 2, '保存后列表标签应为段落');
  assert.equal(doc.window.getComputedStyle(labels[0]).marginTop, '0px', '标注块列表的标签不应增加顶部边距');
  assert.equal(doc.window.getComputedStyle(labels[0]).marginBottom, '0px', '单段标签不应增加底部边距');
  const blocks = new JSDOM(`<style>${css}</style><div class="article"><ul>
    <li><p>代码</p><pre>内容</pre></li><li><p>引用</p><blockquote>内容</blockquote></li>
    <li><p>段落一</p><p>段落二</p></li><li><p>标注</p><div class="callout"></div></li>
    </ul></div>`);
  const blockLabels = blocks.window.document.querySelectorAll('li > p:first-child');
  for (const index of [0, 1, 3]) {
    assert.equal(blocks.window.getComputedStyle(blockLabels[index]).marginBottom, '0px', '非段落块前的标签不应增加底部边距');
  }
  assert.ok(parseFloat(blocks.window.getComputedStyle(blockLabels[2]).marginBottom) > 0, '相邻段落应保留段间距');
  const ordinary = doc.window.document.querySelector('.article > ul:last-child > li > p')!;
  assert.ok(parseFloat(doc.window.getComputedStyle(ordinary).marginTop) > 0, '普通松散列表的段落样式不应改变');

  const callout = rule('.callout');
  assert.match(callout, /border-left:\s*4px solid var\(--callout-line\)/, '左侧色条应与 GitHub 一致（4px）');
  assert.ok(!/background/.test(callout), 'GitHub 的标注块没有底色');
  assert.ok(!/border-radius/.test(callout), 'GitHub 的标注块没有圆角');

  const title = rule('.callout-title');
  assert.match(title, /font-weight:\s*500/, '标题字重应为 500');
  assert.match(title, /line-height:\s*1[;\s]/, '标题行高应为 1');
  assert.match(rule('.callout-icon'), /margin-right:\s*8px/, '图标与标题间距应为 8px');

  // Primer token values, light and dark.
  for (const token of [
    '--callout-note: #0969da',
    '--callout-caution: #d1242f',
    '--callout-caution-line: #cf222e',
    '--callout-note: #4493f8',
    '--callout-note-line: #1f6feb',
    '--callout-caution-line: #da3633',
  ]) {
    assert.ok(css.includes(token), `style.css 应使用 GitHub Primer 颜色 ${token}`);
  }
}

console.log('callout assertions passed');
