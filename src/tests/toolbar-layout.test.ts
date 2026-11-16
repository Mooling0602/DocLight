/*
 * Toolbar layout regression test.
 *
 * A browser-only defect: the "清除格式" button sat far away from the rest of the toolbar.
 * The cause was a `<span class="flex-spacer">` (CSS `flex: 1`) placed before it, which
 * greedily absorbed all leftover width and shoved that single button to the far right.
 * Groups are meant to be separated by a fixed-width `.tsep` divider, never by a growing
 * spacer, so the toolbar must contain no flex-grow element.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const dom = new JSDOM(html);
const document = dom.window.document as Document;

const toolbar = document.querySelector<HTMLElement>('#toolbar');
assert.ok(toolbar, 'index.html 应包含工具栏');

// The toolbar must not stretch any child: that is what created the visible gap.
const stretched = [...toolbar!.children].filter(child => /flex-spacer|flex-grow/.test(child.className));
assert.deepEqual(
  stretched.map(el => el.className), [],
  '工具栏内不得有会撑开空档的元素，分组只能用固定宽度的分隔线',
);
assert.ok(!/\.flex-spacer\b/.test(css), 'style.css 不应再保留 flex-spacer 规则');

// The toolbar box must hug its buttons and center itself: a full-width box left the
// right half empty. `fit-content` shrinks it, `margin-inline: auto` centers it, and
// `max-width: 100%` keeps it scrollable instead of overflowing on narrow screens.
const toolbarRule = css.match(/#toolbar\s*\{[^}]*\}/)?.[0] ?? '';
assert.match(toolbarRule, /width:\s*fit-content/, '#toolbar 应收缩到按钮宽度');
assert.match(toolbarRule, /margin-inline:\s*auto/, '#toolbar 应水平居中');
assert.match(toolbarRule, /max-width:\s*100%/, '#toolbar 应限制最大宽度以免溢出');

// The last button carries removeFormat; it must sit right after a separator, not be flung
// to the far edge. Walk the DOM: previous element of the button is the divider, and the
// element before that is the insertHorizontalRule command it logically continues.
const buttons = [...toolbar!.querySelectorAll<HTMLButtonElement>('.tbtn')];
const last = buttons[buttons.length - 1];
assert.equal(last.dataset.cmd, 'removeFormat', '工具栏最后一个按钮应是清除格式');
assert.equal(last.previousElementSibling?.className, 'tsep', '清除格式前应是分隔线而非撑开空档的元素');
assert.equal(
  last.previousElementSibling?.previousElementSibling?.getAttribute('data-cmd'),
  'insertHorizontalRule',
  '清除格式应紧跟在插入分组之后',
);

// On phones the editor has its own header row instead of squeezing the mode labels vertically.
const editHeader = css.match(/#topbar:has\(#cluster-edit:not\(\[hidden\]\)\)\s*\{([^}]*)\}/)?.[1] ?? '';
assert.match(editHeader, /grid-template-rows:\s*53px\s+46px/, '窄屏编辑态应分两行显示');
assert.match(editHeader, /height:\s*100px/, '窄屏编辑态顶栏高度应覆盖两行');
assert.match(css, /#topbar:has\(#cluster-edit:not\(\[hidden\]\)\)\s+#cluster-edit\s*\{[^}]*grid-area:\s*2\s*\/\s*1\s*\/\s*3\s*\/\s*3/, '编辑按钮应占据第二行');
assert.match(css, /#topbar:has\(#cluster-edit:not\(\[hidden\]\)\)\s+\.seg-btn\s*\{[^}]*white-space:\s*nowrap/, '编辑模式标签不应断成竖排');
assert.match(css, /body:has\(#cluster-edit:not\(\[hidden\]\)\)\s+#layout\s*\{[^}]*100dvh\s*-\s*100px/, '内容区域应扣除两行顶栏高度');
assert.match(css, /body:has\(#cluster-edit:not\(\[hidden\]\)\)\s+#sidebar\s*\{[^}]*top:\s*100px/, '移动导航应位于编辑顶栏下方');
assert.match(css, /body:has\(#cluster-edit:not\(\[hidden\]\)\)\s+#scrim\s*\{[^}]*top:\s*100px/, '导航遮罩应位于编辑顶栏下方');

console.log('toolbar layout assertions passed');
