/*
 * Client-side fallback for the public-security filing badge.
 *
 * The server renders the official badge as a remote image so that the raw HTML inspected
 * by a filing audit contains only the official mark. If the platform's host is slow or
 * unreachable the image would silently disappear, so the client swaps in a drawn shield.
 * The fallback must therefore be attached by the SPA and never by the server.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ICP_PORTAL, injectFooter, policeLookupUrl } from '../beian.js';

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');

const baseHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');

const html = injectFooter(baseHtml, {
  icp: '浙ICP备12345678号-1',
  icpUrl: ICP_PORTAL,
  police: '京公网安备11010502030123号',
  policeUrl: policeLookupUrl('京公网安备11010502030123号'),
  copyright: '',
});

// The server output is already asserted in beian.test.ts; this test starts from it and only
// cares about what the client does with the official image afterwards.
const dom = new JSDOM(html, { url: 'http://localhost:4173/default', pretendToBeVisual: true, runScripts: 'outside-only' });
const window = dom.window as unknown as any;
const document = window.document as Document;

window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window, 'localStorage', {
  value: { _s: {} as Record<string, string>, getItem(key: string) { return this._s[key] ?? null; }, setItem(key: string, value: string) { this._s[key] = value; } },
  configurable: true,
});
window.scrollTo = () => {};
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};
window.fetch = async (url: string) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'setup', authed: false, user: null, salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) return { ok: true, json: async () => ({ spaces: [], pages: [] }) };
  return { ok: true, json: async () => ({}) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);

async function main(): Promise<void> {
  // Before the bundle runs, the badge is the official image and nothing else.
  const original = $('img.sf-badge') as HTMLImageElement;
  assert.ok(original, '服务端应先渲染官方徽标图片');
  assert.ok(
    original.getAttribute('src')!.includes('beian.mps.gov.cn'),
    '官方徽标必须来自备案平台',
  );
  assert.equal($('svg.sf-badge'), null, '客户端脚本运行前不应存在自绘徽标');

  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(60);

  // The image host is unreachable: the error event must swap in the drawn shield.
  const loaded = $('img.sf-badge') as HTMLImageElement;
  if (loaded) loaded.dispatchEvent(new window.Event('error'));
  await wait(10);

  const fallback = $('svg.sf-badge') as SVGElement;
  assert.ok(fallback, '官方图片加载失败后应替换为自绘徽标');
  assert.equal($('img.sf-badge'), null, '兜底后不应再保留失效的官方图片');
  assert.equal(fallback.getAttribute('viewBox'), '0 0 16 16', '兜底图标应有正确的绘制区域');
  assert.equal(fallback.querySelectorAll('path').length, 3, '兜底图标应保留完整盾牌路径');
  assert.ok(!fallback.hasAttribute('hidden'), '兜底图标必须可见');

  // The filing number and its link survive the swap — the legal requirement outranks the icon.
  const link = $('a.sf-link[href*="beian.mps.gov.cn"]') as HTMLAnchorElement;
  assert.ok(link && link.textContent!.includes('京公网安备11010502030123号'), '兜底后备案号与链接必须保持不变');

  console.log('filing badge assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
