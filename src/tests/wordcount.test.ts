import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const functionSource = source.match(/function wordCount[\s\S]*?\n}/)?.[0];

assert.ok(functionSource, 'wordCount function must exist');

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

const wordCount = new Function('document', `${functionSource}; return wordCount;`)(document) as (html: string) => number;

assert.equal(wordCount('你好 <b>world</b> 世界 hello'), 6);
assert.equal(wordCount('可视化编辑器真棒'), 8);
assert.equal(wordCount(''), 0);
console.log('wordCount assertions passed');
