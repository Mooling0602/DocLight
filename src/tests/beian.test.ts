/*
 * Regression tests for the filing footer.
 *
 * The regulatory requirement is that the filing number is present at the bottom of
 * the page and links to the authority portal. Official compliance checks fetch the
 * HTML and look at the markup *without* executing scripts, so the assertions below
 * deliberately test the raw server-rendered string rather than the DOM after the SPA
 * boots. Rendering this client-side would satisfy a human visitor and fail an audit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  FOOTER_MARKER,
  ICP_PORTAL,
  POLICE_PORTAL,
  escapeHtml,
  hasFiling,
  injectFooter,
  policeLookupUrl,
  readFooterOptions,
  renderFooter,
  safeUrl,
} from '../beian.js';

const root = path.resolve(__dirname, '../..');
const indexHtmlSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// The footer badge is an <img>, so the global article-level `img` rule would clip it with
// border-radius and ring it with box-shadow. The .sf-badge rule must reset both.
const styleSource = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const badgeRule = (styleSource.match(/\.sf-badge\s*\{[^}]*\}/) || [''])[0];
assert.match(badgeRule, /border-radius:\s*0/, '.sf-badge 必须重置全局 img 的圆角');
assert.match(badgeRule, /box-shadow:\s*none/, '.sf-badge 必须重置全局 img 的阴影');

const FULL = {
  icp: '浙ICP备12345678号-1',
  icpUrl: ICP_PORTAL,
  police: '京公网安备11010502030123号',
  policeUrl: policeLookupUrl('京公网安备11010502030123号'),
  copyright: '© 2026 Mooling',
};

/* ---------- Rendering ---------- */

const full = renderFooter(FULL);
assert.ok(full.startsWith('<footer'), '应渲染出 footer 元素');
assert.ok(full.includes('浙ICP备12345678号-1'), '应包含 ICP 备案号');
assert.ok(full.includes('京公网安备11010502030123号'), '应包含公安备案号');
assert.ok(full.includes('© 2026 Mooling'), '应包含版权行');

// Links point at the official lookup portals — the actual checkpoint in a filing audit
assert.ok(full.includes(`href="${ICP_PORTAL}"`), 'ICP 备案号必须链接到工信部');
assert.ok(full.includes('https://beian.mps.gov.cn/'), '公安备案号必须链接到公安部');

// The public-security badge must be the official artwork published by the filing platform.
// A hand-drawn shield ships alongside it as a fallback for when the external host is
// unreachable, but it must start hidden so the official mark is what visitors see.
assert.ok(
  full.includes('<img class="sf-badge" src="https://beian.mps.gov.cn/web/assets/logo01.6189a29f.png"'),
  '公安备案必须使用官方平台的徽标图片',
);
assert.ok(full.includes('class="sf-badge sf-badge-fallback"'), '应提供自绘兜底图标');
assert.ok(
  /class="sf-badge sf-badge-fallback"[^>]*\shidden/.test(full),
  '兜底图标默认必须隐藏，不能与官方图标同时出现',
);

// Fire the real onerror handler in a DOM: the external image is the primary mark, and if
// it fails the fallback must take over instead of leaving the badge blank. JSDOM does not
// load images, so the error is dispatched explicitly.
const badgeDom = new JSDOM(`<body>${full}</body>`, { runScripts: 'dangerously' });
const badgeDoc = badgeDom.window.document as Document;
const badgeImg = badgeDoc.querySelector<HTMLImageElement>('img.sf-badge')!;
const badgeFallback = badgeDoc.querySelector<SVGElement>('svg.sf-badge-fallback')!;
assert.ok(badgeImg && badgeFallback, '徽标应同时包含官方图片与自绘兜底');
assert.equal(badgeFallback.hasAttribute('hidden'), true, '加载成功前兜底应保持隐藏');
badgeImg.dispatchEvent(new badgeDom.window.Event('error'));
assert.equal(badgeImg.hidden, true, '官方图片加载失败后应隐藏');
assert.equal(badgeFallback.hasAttribute('hidden'), false, '官方图片加载失败后应显示自绘兜底');
badgeDom.window.close();

// Opening in a new tab requires rel to prevent reverse tabnabbing
assert.ok(full.includes('rel="noopener noreferrer"'), '外链应带 rel=noopener');

/* ---------- Optionality: nothing should be left behind when unconfigured ---------- */

const none = { icp: '', icpUrl: ICP_PORTAL, police: '', policeUrl: POLICE_PORTAL, copyright: '' };
assert.equal(renderFooter(none), '', '未配置备案信息时应渲染为空');
assert.equal(hasFiling(none), false, 'hasFiling 应为 false');

// A single field should render as well
assert.ok(renderFooter({ ...none, icp: '京ICP备1号' }).includes('京ICP备1号'), '仅配 ICP 也应渲染');
assert.ok(renderFooter({ ...none, copyright: '© X' }).includes('© X'), '仅配版权也应渲染');
assert.equal(hasFiling({ ...none, copyright: '© X' }), true, '仅配版权时 hasFiling 应为 true');

/* ---------- Injection ---------- */

// Start from the real index.html to ensure the marker exists and injection works
assert.ok(indexHtmlSource.includes(FOOTER_MARKER), 'index.html 必须保留备案注入标记位');

const injected = injectFooter(indexHtmlSource, FULL);
assert.ok(injected.includes('浙ICP备12345678号-1'), '注入后应含备案号');
assert.ok(!injected.includes(FOOTER_MARKER), '注入后不应残留标记位');
assert.ok(injected.includes('</body>'), '注入不应破坏文档结构');

// The marker must be consumed when unconfigured; internal hooks must not leak to visitors
const stripped = injectFooter(indexHtmlSource, none);
assert.ok(!stripped.includes(FOOTER_MARKER), '未配置时也不应残留标记位');

// Fallback for a missing marker: filing is a legal duty, it must not vanish silently on template changes
const noMarker = indexHtmlSource.replace(FOOTER_MARKER, '');
const fallback = injectFooter(noMarker, FULL);
assert.ok(fallback.includes('浙ICP备12345678号-1'), '缺少标记位时应回退注入到 </main> 前');
assert.ok(fallback.includes('<footer'), '兜底路径也应生成 footer');

/* ---------- Escaping and URL allowlist ---------- */

assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;', 'HTML 应被转义');
assert.equal(escapeHtml('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;', '引号与 & 应被转义');

const xss = renderFooter({ ...FULL, copyright: '<img src=x onerror=alert(1)>' });
// The footer legitimately contains the official badge <img>, so check the payload itself
// rather than blanket-rejecting every tag: the raw markup must be escaped, never parsed.
assert.ok(!xss.includes('<img src=x onerror'), '版权文本中的标签必须被转义，不能注入');
assert.ok(xss.includes('&lt;img src=x onerror=alert(1)&gt;'), '应保留转义后的可见文本');

// The filing number is admin-provided but appears on every page, so links must restrict the protocol
assert.equal(safeUrl('javascript:alert(1)', ICP_PORTAL), ICP_PORTAL, 'javascript: 应被拒绝');
assert.equal(safeUrl('  https://example.com/x  ', ICP_PORTAL), 'https://example.com/x', '合法 https 应通过');
assert.equal(safeUrl('', ICP_PORTAL), ICP_PORTAL, '空值应回退默认');
assert.equal(safeUrl('ftp://x/y', ICP_PORTAL), ICP_PORTAL, '非 http(s) 协议应被拒绝');

const evil = renderFooter({ ...FULL, icpUrl: 'javascript:alert(1)' });
assert.ok(!evil.includes('javascript:'), '注入的 javascript: 链接必须被替换为官方地址');

/* ---------- Police filing number → lookup link ---------- */

assert.equal(
  policeLookupUrl('京公网安备11010502030123号'),
  'https://beian.mps.gov.cn/#/query/webSearch?code=11010502030123',
  '应从备案号中提取数字生成查询链接',
);
assert.equal(policeLookupUrl(''), POLICE_PORTAL, '无号码时回退到门户首页');
assert.equal(policeLookupUrl('京公网安备号'), POLICE_PORTAL, '无数字时回退到门户首页');

/* ---------- Merged-config parsing ---------- */

const fromConfig = readFooterOptions({
  icp: '  浙ICP备12345678号-1  ',
  icpUrl: '',
  police: '京公网安备11010502030123号',
  policeUrl: '',
  copyright: '© 2026 Mooling',
});
assert.equal(fromConfig.icp, '浙ICP备12345678号-1', '配置值两侧空白应被裁剪');
assert.equal(fromConfig.icpUrl, ICP_PORTAL, '未指定时 ICP 链接应默认指向工信部');
assert.equal(
  fromConfig.policeUrl,
  'https://beian.mps.gov.cn/#/query/webSearch?code=11010502030123',
  '未指定时公安链接应由备案号推导',
);

// Explicit link override
const overridden = readFooterOptions({
  icp: '浙ICP备1号',
  icpUrl: 'https://example.com/icp',
  police: '',
  policeUrl: '',
  copyright: '',
});
assert.equal(overridden.icpUrl, 'https://example.com/icp', '显式 ICP 链接应生效');

const emptyConfig = readFooterOptions({ icp: '', icpUrl: '', police: '', policeUrl: '', copyright: '' });
assert.equal(hasFiling(emptyConfig), false, '全空配置应视为未配置备案');

console.log('beian footer assertions passed');
