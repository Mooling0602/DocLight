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
