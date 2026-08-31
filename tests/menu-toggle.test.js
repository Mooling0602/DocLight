/* 下拉菜单开关回归测试 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('/data/data/com.termux/files/home/docsite/public/index.html', 'utf8')
  .replace('<script src="/app.js?v=25" defer></script>', '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
const dom = new JSDOM(html, { url: 'http://localhost:4173/default', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window, d = w.document;
w.matchMedia = q => ({ matches: false, addEventListener() {}, removeEventListener() {} });
w.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } };
w.scrollTo = () => {};
w.fetch = async u => {
  u = String(u);
  if (u.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'setup', authed: false, user: null, salt: '00', iters: 1 }) };
  if (u.includes('/api/tree')) return { ok: true, json: async () => ({ spaces: [], pages: [] }) };
  return { ok: true, json: async () => ({}) };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = (name, cond) => console.log((cond ? '✓ ' : '✗ ') + name);

(async () => {
  w.eval(fs.readFileSync('/data/data/com.termux/files/home/docsite/public/app.js', 'utf8'));
  await sleep(60);
  const q = s => d.querySelector(s);

  q('#btn-theme').click(); await sleep(20);
  T('主题菜单：点开', !q('#menu-theme').hidden);
  q('#btn-theme').click(); await sleep(20);
  T('主题菜单：再点关闭', q('#menu-theme').hidden);

  // 未登录时 cluster-view 隐藏，手动显示模拟登录态
  q('#cluster-view').hidden = false;
  q('#btn-more').click(); await sleep(20);
  const mp = q('#menu-page');
  T('页面操作菜单（⋯）：点开，含 ' + mp.querySelectorAll('.menu-item').length + ' 项', !mp.hidden);
  q('#btn-more').click(); await sleep(20);
  T('页面操作菜单：再点关闭', mp.hidden);

  q('#btn-more').click(); await sleep(20);
  d.body.click(); await sleep(20);
  T('点击外部自动关闭', mp.hidden);

  // 主题菜单与页面菜单互斥
  q('#btn-theme').click(); await sleep(20);
  q('#btn-more').click(); await sleep(20);
  T('两个菜单互斥（打开⋯时主题关闭）', q('#menu-theme').hidden && !mp.hidden);

  console.log('完成');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
