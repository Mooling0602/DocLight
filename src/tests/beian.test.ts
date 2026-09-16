/*
 * Regression tests for the filing footer (备案号悬挂).
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

const FULL = {
  icp: '浙ICP备12345678号-1',
  icpUrl: ICP_PORTAL,
  police: '京公网安备11010502030123号',
  policeUrl: policeLookupUrl('京公网安备11010502030123号'),
  copyright: '© 2026 Mooling',
};

/* ---------- 渲染 ---------- */

const full = renderFooter(FULL);
assert.ok(full.startsWith('<footer'), '应渲染出 footer 元素');
assert.ok(full.includes('浙ICP备12345678号-1'), '应包含 ICP 备案号');
assert.ok(full.includes('京公网安备11010502030123号'), '应包含公安备案号');
assert.ok(full.includes('© 2026 Mooling'), '应包含版权行');

// 链接指向官方查询入口——这是备案核查的实际检查点
assert.ok(full.includes(`href="${ICP_PORTAL}"`), 'ICP 备案号必须链接到工信部');
assert.ok(full.includes('https://beian.mps.gov.cn/'), '公安备案号必须链接到公安部');

// 新窗口打开需带 rel，避免反向标签劫持
assert.ok(full.includes('rel="noopener noreferrer"'), '外链应带 rel=noopener');

/* ---------- 可选性：未配置时不应留下任何痕迹 ---------- */

const none = { icp: '', icpUrl: ICP_PORTAL, police: '', policeUrl: POLICE_PORTAL, copyright: '' };
assert.equal(renderFooter(none), '', '未配置备案信息时应渲染为空');
assert.equal(hasFiling(none), false, 'hasFiling 应为 false');

// 单个字段也应生效
assert.ok(renderFooter({ ...none, icp: '京ICP备1号' }).includes('京ICP备1号'), '仅配 ICP 也应渲染');
assert.ok(renderFooter({ ...none, copyright: '© X' }).includes('© X'), '仅配版权也应渲染');
assert.equal(hasFiling({ ...none, copyright: '© X' }), true, '仅配版权时 hasFiling 应为 true');

/* ---------- 注入 ---------- */

// 从真实 index.html 出发，确保标记位确实存在且注入可用
assert.ok(indexHtmlSource.includes(FOOTER_MARKER), 'index.html 必须保留备案注入标记位');

const injected = injectFooter(indexHtmlSource, FULL);
assert.ok(injected.includes('浙ICP备12345678号-1'), '注入后应含备案号');
assert.ok(!injected.includes(FOOTER_MARKER), '注入后不应残留标记位');
assert.ok(injected.includes('</body>'), '注入不应破坏文档结构');

// 未配置时标记位必须被消费掉，不能把内部钩子暴露给访客
const stripped = injectFooter(indexHtmlSource, none);
assert.ok(!stripped.includes(FOOTER_MARKER), '未配置时也不应残留标记位');

// 标记位丢失时的兜底：备案是法定义务，不能因为模板改动就静默消失
const noMarker = indexHtmlSource.replace(FOOTER_MARKER, '');
const fallback = injectFooter(noMarker, FULL);
assert.ok(fallback.includes('浙ICP备12345678号-1'), '缺少标记位时应回退注入到 </main> 前');
assert.ok(fallback.includes('<footer'), '兜底路径也应生成 footer');

/* ---------- 转义与 URL 白名单 ---------- */

assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;', 'HTML 应被转义');
assert.equal(escapeHtml('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;', '引号与 & 应被转义');

const xss = renderFooter({ ...FULL, copyright: '<img src=x onerror=alert(1)>' });
assert.ok(!xss.includes('<img'), '版权文本中的标签必须被转义，不能注入');
assert.ok(xss.includes('&lt;img'), '应保留转义后的可见文本');

// 备案号是管理员配置项，但会出现在每个页面，因此链接必须限制协议
assert.equal(safeUrl('javascript:alert(1)', ICP_PORTAL), ICP_PORTAL, 'javascript: 应被拒绝');
assert.equal(safeUrl('  https://example.com/x  ', ICP_PORTAL), 'https://example.com/x', '合法 https 应通过');
assert.equal(safeUrl('', ICP_PORTAL), ICP_PORTAL, '空值应回退默认');
assert.equal(safeUrl('ftp://x/y', ICP_PORTAL), ICP_PORTAL, '非 http(s) 协议应被拒绝');

const evil = renderFooter({ ...FULL, icpUrl: 'javascript:alert(1)' });
assert.ok(!evil.includes('javascript:'), '注入的 javascript: 链接必须被替换为官方地址');

/* ---------- 公安备案号 → 查询链接 ---------- */

assert.equal(
  policeLookupUrl('京公网安备11010502030123号'),
  'https://beian.mps.gov.cn/#/query/webSearch?code=11010502030123',
  '应从备案号中提取数字生成查询链接',
);
assert.equal(policeLookupUrl(''), POLICE_PORTAL, '无号码时回退到门户首页');
assert.equal(policeLookupUrl('京公网安备号'), POLICE_PORTAL, '无数字时回退到门户首页');

/* ---------- 环境变量读取 ---------- */

const fromEnv = readFooterOptions({
  DOCLIGHT_ICP: '  浙ICP备12345678号-1  ',
  DOCLIGHT_POLICE: '京公网安备11010502030123号',
  DOCLIGHT_COPYRIGHT: '© 2026 Mooling',
} as NodeJS.ProcessEnv);
assert.equal(fromEnv.icp, '浙ICP备12345678号-1', '环境变量两侧空白应被裁剪');
assert.equal(fromEnv.icpUrl, ICP_PORTAL, '未指定时 ICP 链接应默认指向工信部');
assert.equal(
  fromEnv.policeUrl,
  'https://beian.mps.gov.cn/#/query/webSearch?code=11010502030123',
  '未指定时公安链接应由备案号推导',
);

// 显式覆盖链接
const overridden = readFooterOptions({
  DOCLIGHT_ICP: '浙ICP备1号',
  DOCLIGHT_ICP_URL: 'https://example.com/icp',
} as NodeJS.ProcessEnv);
assert.equal(overridden.icpUrl, 'https://example.com/icp', '显式 ICP 链接应生效');

const emptyEnv = readFooterOptions({} as NodeJS.ProcessEnv);
assert.equal(hasFiling(emptyEnv), false, '空环境应视为未配置备案');

console.log('beian footer assertions passed');
