/* DocLight 交互流测试：放弃修改 → 必须退出编辑态 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const PUB = '/data/data/com.termux/files/home/docsite/public';
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
  .replace('<script src="/app.js?v=3" defer></script>', '')
  .replace(/<script>[\s\S]*?<\/script>/, ''); // 去掉主题预置与外部脚本，手动注入

const dom = new JSDOM(html, { url: 'http://localhost:4173/default', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
const { document } = window;

window.matchMedia = window.matchMedia || (q => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } };
window.navigator.clipboard = { writeText: async () => {} };

// fetch 桩：v3 树 + 鉴权 + 任意 slug 的页面详情
window.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes('/api/auth/')) {
    if (url.includes('state')) {
      return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
    }
    return { ok: true, json: async () => ({ ok: true, user: 'tester' }) };
  }
  if (url.includes('/api/tree')) {
    return { ok: true, json: async () => ({
      spaces: [{ slug: 'default', title: '欢迎使用 DocLight', desc: '', home: 'welcome', createdAt: Date.now(), updatedAt: Date.now() }],
      pages: [{ slug: 'welcome', space: 'default', parent: null, title: '欢迎使用 DocLight', createdAt: Date.now(), updatedAt: Date.now() }],
    }) };
  }
  const page = {
    slug: 'welcome', space: 'default', parent: null,
    title: '欢迎使用 DocLight',
    content: '<h1>欢迎使用 DocLight ✦</h1><p>正文</p>',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  return { ok: true, json: async () => page };
};
window.scrollTo = () => {};
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};

let failures = [];
const check = (name, cond) => { console.log((cond ? '✓ ' : '✗ ') + name); if (!cond) failures.push(name); };

(async () => {
  const appSrc = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  // 在 jsdom 环境执行 app.js
  window.eval(appSrc);
  await new Promise(r => setTimeout(r, 50)); // 等 boot() 完成

  const $ = s => document.querySelector(s);
  const editWrap = $('#edit-wrap'), article = $('#article');

  // 1) 初始：进入编辑
  $('#btn-edit').click();
  await new Promise(r => setTimeout(r, 20));
  check('进入编辑态', editWrap.hidden === false && $('#cluster-edit').hidden === false);

  // 2) 输入触发 dirty
  $('#editor').innerHTML = '<p>被修改的内容</p>';
  $('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('脏标记出现', $('#dirty-pill').hidden === false);

  // 3) 点取消 → 弹确认框
  $('#btn-cancel').click();
  await new Promise(r => setTimeout(r, 20));
  const modal = $('#modal-root');
  check('确认框弹出', modal.hidden === false);
  check('确认框含「放弃修改」', modal.textContent.includes('放弃修改'));

  // 4) 点「放弃修改」
  const okBtn = modal.querySelector('[data-x=ok]');
  check('ok 按钮存在', !!okBtn);
  okBtn.click();
  await new Promise(r => setTimeout(r, 50));

  // 5) 断言：已退出编辑态
  check('★ 编辑区已隐藏（退出编辑态）', editWrap.hidden === true);
  check('★ 编辑按钮簇已隐藏', $('#cluster-edit').hidden === true);
  check('★ 文章视图已恢复', article.hidden === false);
  check('★ 脏标记已清除', $('#dirty-pill').hidden === true);
  check('工具栏已隐藏', $('#toolbar-wrap').hidden === true);

  console.log(failures.length ? `\n❌ 失败 ${failures.length} 项` : '\n✅ 全部通过');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
