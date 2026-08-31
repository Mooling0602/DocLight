// wordCount 单测：用最小 DOM 桩替代浏览器环境
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/public/app.js', 'utf8');
const fnSrc = src.match(/function wordCount[\s\S]*?\n}/)[0];

const document = {
  createElement() {
    return {
      innerHTML: '',
      get textContent() {
        const html = this.innerHTML
          .replace(/<[^>]*>/g, ' ')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        return { trim: () => html.trim() };
      },
    };
  },
};

eval(fnSrc);

const cases = [
  ['<p>你好 <b>world</b> 世界 hello</p>', '中英混合'],
  ['<p>可视化编辑器真棒</p>', '纯中文'],
  ['<pre><code>node server.js\nconst a = 1;</code></pre>', '代码块'],
  ['', '空字符串'],
  ['<p></p>', '空段落'],
];

let fail = 0;
for (const [input, name] of cases) {
  const n = wordCount(input);
  if (typeof n !== 'number' || Number.isNaN(n)) { console.log(`✗ ${name}: 非法结果 ${n}`); fail++; }
  else console.log(`✓ ${name}: ${n}`);
}

// 期望值人工断言
const assert = require('assert');
assert.strictEqual(wordCount('你好 <b>world</b> 世界 hello'), 6); // 4 CJK + 2 words
assert.strictEqual(wordCount('可视化编辑器真棒'), 8);
assert.strictEqual(wordCount(''), 0);
console.log(fail ? '存在失败' : '✅ wordCount 全部断言通过');
