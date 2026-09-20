/*
 * wordCount now receives Markdown, not HTML (page content is stored as Markdown in db v4).
 * It is extracted from the compiled bundle and runs DOM-free, so the count reflects the
 * visible text without the Markdown syntax inflating it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const functionSource = source.match(/function wordCount[\s\S]*?\n  \}/)?.[0]
  || source.match(/function wordCount[\s\S]*?\n\}/)?.[0];

assert.ok(functionSource, 'wordCount function must exist');

const wordCount = new Function(`${functionSource}; return wordCount;`)() as (markdown: string) => number;

// Markdown emphasis must not add words: `**轻量**` is still two characters.
assert.equal(wordCount('# 你好 world 世界 hello'), 6);
assert.equal(wordCount('可视化编辑器真棒'), 8);
assert.equal(wordCount(''), 0);
// Syntax is stripped: heading markers, fences, inline code and link targets.
assert.equal(wordCount('## 标题'), 2);
assert.equal(wordCount('```\nconst a = 1\n```'), 3);
assert.equal(wordCount('看 [链接](https://example.com) 吧'), 4);
assert.equal(wordCount('`npm install`'), 2);
console.log('wordCount assertions passed');
