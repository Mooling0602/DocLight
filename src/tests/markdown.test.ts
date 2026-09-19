/*
 * Markdown storage and rendering tests (database v4).
 *
 * Page content is stored as Markdown, but the editor is still a WYSIWYG surface and the
 * author may keep formatting Markdown cannot express (underline, alignment, colour) as raw
 * inline HTML. Two properties therefore matter:
 *
 *   1. Conversion is lossless for the supported set — a save must not silently drop content.
 *   2. Rendering raw HTML is still safe — anything that survives the converter is sanitised
 *      in the browser before it reaches the DOM, so inline preservation is not an XSS hole.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { htmlToMarkdown, sanitizeMarkdown } from '../markdown.js';

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');

/* ---------------------------------------------------- conversion (server + client) */

// Markdown-native formatting becomes clean Markdown.
assert.equal(htmlToMarkdown('<h1>标题</h1>'), '# 标题');
assert.equal(htmlToMarkdown('<p><b>粗</b>与<i>斜</i></p>'), '**粗**与*斜*');
assert.equal(htmlToMarkdown('<ul><li>甲</li><li>乙</li></ul>'), '- 甲\n- 乙');
assert.equal(htmlToMarkdown('<ol><li>甲</li><li>乙</li></ol>'), '1. 甲\n2. 乙');
assert.equal(htmlToMarkdown('<blockquote><p>引用</p></blockquote>'), '> 引用');
assert.equal(htmlToMarkdown('<pre><code>npm install</code></pre>'), '```\nnpm install\n```');
assert.equal(htmlToMarkdown('<p>看<a href="#/guide">指南</a></p>'), '看[指南](#/guide)');

// List padding is normalized, but a code block whose lines look like list items is untouched.
assert.equal(htmlToMarkdown('<ul><li>甲<ul><li>乙</li></ul></li></ul>'), '- 甲\n    - 乙');
assert.equal(
  htmlToMarkdown('<pre><code>- 保持原样\n    - 缩进也保持</code></pre>'),
  '```\n- 保持原样\n    - 缩进也保持\n```',
);

// Markdown has no underline syntax: the tag is preserved so the round-trip keeps it.
assert.equal(htmlToMarkdown('<p><u>下划线</u></p>'), '<u>下划线</u>');

// GFM constructs that the visual editor can produce must survive a save, not collapse to text.
assert.equal(
  htmlToMarkdown('<table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'),
  '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |',
);
assert.equal(htmlToMarkdown('<p><s>删除线</s></p>'), '~~删除线~~');
assert.equal(
  htmlToMarkdown('<ul><li><input type="checkbox" checked disabled> 完成</li><li><input type="checkbox" disabled> 未完成</li></ul>'),
  '- [x] 完成\n- [ ] 未完成',
);

// Inline style is preserved verbatim (alignment / colour); dropping it would lose intent.
assert.equal(
  htmlToMarkdown('<p style="text-align:center;color:#8a8f9f">居中</p>'),
  '<p style="text-align:center;color:#8a8f9f">居中</p>',
);

// Empty content stays empty rather than becoming a stray newline.
assert.equal(htmlToMarkdown(''), '');
assert.equal(htmlToMarkdown('   '), '');

// sanitizeMarkdown normalises line endings and bounds the stored size (1MB body / 500KB cap).
assert.equal(sanitizeMarkdown('a\r\nb'), 'a\nb');
assert.equal(sanitizeMarkdown('x'.repeat(600 * 1024)).length, 500 * 1024);
assert.equal(sanitizeMarkdown(null), '');

/* ---------------------------------------------------- seed round-trip stability
   Opening a page renders stored Markdown, and saving serialises the editor DOM back. That
   cycle must be idempotent: otherwise every save would rewrite a page to something slightly
   different and the stored file would churn. The shipped sample pages are the fixtures. */
{
  const domForPurify = new JSDOM('<!doctype html><body></body>');
  // jsdom's Window is structurally compatible with DOMPurify's WindowLike at runtime, but the
  // bundled types require the DOM globals to be declared on the same object.
  const purify = createDOMPurify(domForPurify.window as unknown as Parameters<typeof createDOMPurify>[0]);
  const roundTrip = (markdown: string): string =>
    htmlToMarkdown(purify.sanitize(marked.parse(markdown, { async: false }) as string));
  const seed = JSON.parse(fs.readFileSync(path.join(root, 'template', 'pages.json'), 'utf8'));
  assert.equal(seed.version, 4, '示例数据应为 v4（Markdown）');
  for (const page of seed.pages) {
    const once = roundTrip(page.content);
    assert.equal(once, page.content.trim(), `${page.slug}: 打开再保存不应改动内容`);
    assert.equal(roundTrip(once), once, `${page.slug}: 二次往返应稳定`);
  }
}

/* ---------------------------------------------------- browser rendering + sanitize */

const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
const dom = new JSDOM(html, { url: 'http://localhost:4173/default/welcome', pretendToBeVisual: true, runScripts: 'outside-only' });
const window = dom.window as unknown as any;
const document = window.document as Document;

window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window, 'localStorage', {
  value: { _s: {} as Record<string, string>, getItem(key: string) { return this._s[key] ?? null; }, setItem(key: string, value: string) { this._s[key] = value; } },
  configurable: true,
});
window.scrollTo = () => {};
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};

// A page whose Markdown mixes legitimate formatting with injection attempts.
const EVIL_CONTENT = [
  '# 标题',
  '',
  '正文 **粗体** 文本。',
  '',
  '<script>window.__pwned = true</script>',
  '',
  '<img src=x onerror="window.__pwned = true">',
  '',
  '<u>保留的下划线</u>',
].join('\n');

window.fetch = async (url: string) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) {
    return { ok: true, json: async () => ({
      spaces: [{ slug: 'default', title: '空间', desc: '', home: 'welcome', createdAt: Date.now(), updatedAt: Date.now() }],
      pages: [{ slug: 'welcome', space: 'default', parent: null, title: '标题', createdAt: Date.now(), updatedAt: Date.now() }],
    }) };
  }
  return { ok: true, json: async () => ({
    slug: 'welcome', space: 'default', parent: null, title: '标题',
    content: EVIL_CONTENT, createdAt: Date.now(), updatedAt: Date.now(),
  }) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(80);

  const article = document.querySelector<HTMLElement>('#article')!;
  const rendered = article.innerHTML;

  // Markdown was rendered to real markup.
  assert.match(rendered, /<h1[^>]*>标题<\/h1>/, '标题 should render as an h1');
  assert.match(rendered, /<strong>粗体<\/strong>/, 'emphasis should render as strong');

  // Injection attempts are neutralised before reaching the DOM.
  assert.equal(article.querySelector('script'), null, 'script tags must be stripped');
  assert.equal(article.querySelector('[onerror]'), null, 'inline event handlers must be stripped');
  assert.equal(window.__pwned, undefined, 'no injected script may execute');

  // The supported inline HTML survives sanitising, so the author keeps their formatting.
  assert.ok(article.querySelector('u'), 'preserved <u> should survive the sanitize pass');

  console.log('markdown assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
