/*
 * The reading view must stay usable when the page tree contains a cycle.
 *
 * Two page shapes break naive parent walks: a self-referencing page (`page.parent === page.slug`)
 * and a two-page cycle (`a.parent === b`, `b.parent === a`). Nothing in the frontend forbids them
 * in the data it receives, and both used to freeze the whole app rather than one page:
 *
 *   · `chainOf` walked `parent` links without remembering visited slugs and never terminated;
 *   · `revealPath` walked the same chain a second time and looped the same way.
 *
 * The sidebar calls `canonicalPath` → `chainOf` for every row, so one cyclic page hung the tab on
 * every route, including pages that are not part of the cycle.
 *
 * A frozen event loop cannot report its own failure: timers never fire, so a plain in-process test
 * would hang the runner instead of failing. Each scenario therefore boots the real client bundle in
 * a child process, and the parent asserts on that process — it must finish within a budget and print
 * a sentinel line. A budget overrun is reported as a failure and the child is killed with SIGKILL,
 * because a process spinning in JavaScript never runs a SIGTERM handler. One extra scenario spins on
 * purpose so that the watchdog itself is covered: if it ever stops killing stuck children, that test
 * fails instead of silently hanging the suite.
 *
 * Run it after `npm run build:tests`:
 *   node dist/tests/page-cycle-ui.test.js
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(__dirname, '../..');
/** Set by the parent for the child run; its presence switches the file into child mode. */
const CHILD_SCENARIO = process.env.DOCLIGHT_CYCLE_CHILD ?? '';
const CHILD_BUNDLE = process.env.DOCLIGHT_CYCLE_BUNDLE ?? '';
/** Printed by a child only after every assertion in its scenario passed. */
const CHILD_OK = 'PAGE-CYCLE-CHILD-OK';
/** Generous: a child boots JSDOM and never builds anything, so a healthy run takes well under a second. */
const CHILD_TIMEOUT_MS = 20_000;
/** The spinning child is expected to be killed, so its budget only has to exceed process startup. */
const SPIN_TIMEOUT_MS = 3_000;

/* ---------------------------------------------------------------- fixtures */

interface TestPage {
  slug: string;
  space: string;
  parent: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface TestSpace {
  slug: string;
  title: string;
  desc: string;
  home: string | null;
  recommend: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Fixture {
  spaces: TestSpace[];
  pages: TestPage[];
}

const DOCS_SPACE: TestSpace = { slug: 'docs', title: 'Docs', desc: '', home: null, recommend: true, createdAt: 1, updatedAt: 1 };

/** Timestamps are distinct so the sidebar order is stable for every sort key. */
function pageOf(slug: string, parent: string | null, title: string, stamp: number): TestPage {
  return { slug, space: 'docs', parent, title, createdAt: stamp, updatedAt: stamp };
}

const SAFE_PAGE = pageOf('safe', null, 'Safe', 13);
const ALPHA_PAGE = pageOf('alpha', null, 'Alpha', 14);
const BETA_PAGE = pageOf('beta', 'alpha', 'Beta', 15);
const GAMMA_PAGE = pageOf('gamma', 'beta', 'Gamma', 16);

/** Self-reference, two-page cycle and one ordinary chain, all in the same space. */
const CYCLIC: Fixture = {
  spaces: [DOCS_SPACE],
  pages: [
    pageOf('self', 'self', 'Self', 10),
    pageOf('ping', 'pong', 'Ping', 11),
    pageOf('pong', 'ping', 'Pong', 12),
    SAFE_PAGE,
    ALPHA_PAGE,
    BETA_PAGE,
    GAMMA_PAGE,
  ],
};

/** The same space without cycles: the control case that must not regress. */
const NORMAL: Fixture = { spaces: [DOCS_SPACE], pages: [SAFE_PAGE, ALPHA_PAGE, BETA_PAGE, GAMMA_PAGE] };

/* ---------------------------------------------------------------- shared helpers */

/** Crumb entries in document order; separators (`<span class="sep">`) are dropped. */
function crumbParts(d: Document): Element[] {
  const nav = d.querySelector('#article .crumbs');
  assert.ok(nav, 'the reading view renders a breadcrumb trail');
  return [...nav.children].filter(node => !node.classList.contains('sep') && (node.textContent || '').trim() !== '');
}

function crumbTitles(d: Document): string[] {
  return crumbParts(d).map(part => (part.textContent || '').trim());
}

function crumbLinks(d: Document): string[] {
  return crumbParts(d).filter(part => part.tagName === 'A').map(part => part.getAttribute('href') || '');
}

function slugChip(d: Document): string {
  return (d.querySelector('#article .slug-chip')?.textContent || '').trim();
}

/**
 * A trail may never exceed one entry per page plus the space, may not repeat a page and may not
 * produce links deeper than the tree. This is what "finite path" means for a cycle: the walk stops,
 * and every URL it published is still a real page path.
 */
function assertFiniteTrail(d: Document, fixture: Fixture, label: string): void {
  const parts = crumbParts(d);
  assert.ok(parts.length <= fixture.pages.length + 1, `${label}: breadcrumb stays bounded, got ${parts.length} entries`);
  const titles = parts.map(part => (part.textContent || '').trim());
  assert.equal(new Set(titles).size, titles.length, `${label}: no page repeats in the breadcrumb (${titles.join(' / ')})`);
  for (const part of parts) {
    if (part.tagName !== 'A') continue;
    const href = part.getAttribute('href') || '';
    const depth = href.split('/').filter(Boolean).length;
    assert.ok(depth <= fixture.pages.length + 1, `${label}: ${href} stays within tree depth`);
  }
}

/** Anything a runaway walk would leave behind: stack exhaustion, render errors, thrown exceptions. */
function assertNoRunaway(errors: string[], label: string): void {
  const fatal = errors.filter(text => /Maximum call stack|RangeError|渲染出错|Cannot read|is not a function/i.test(text));
  assert.deepEqual(fatal, [], `${label}: the client logged no failure\n${fatal.join('\n')}`);
}

/* ---------------------------------------------------------------- child: boot the real client */

interface Booted {
  dom: JSDOM;
  w: any;
  d: Document;
  errors: string[];
  click(target: Element | null, label: string): void;
  waitFor(predicate: () => boolean, label: string, timeoutMs?: number): Promise<void>;
  waitForSlug(slug: string): Promise<void>;
  pushes(): number;
  replaces(): number;
}

function shellHtml(): string {
  return fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
    .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
    .replace(/<script>[\s\S]*?<\/script>/, '');
}

/** Same shell/stub recipe as the other UI tests, plus bookkeeping that proves navigation is finite. */
async function bootUi(fixture: Fixture, pathname: string): Promise<Booted> {
  assert.ok(CHILD_BUNDLE, 'the parent passes the prebuilt client bundle to the child');
  const bundle = fs.readFileSync(CHILD_BUNDLE, 'utf8');
  const dom = new JSDOM(shellHtml(), { url: 'http://localhost:4173' + pathname, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window as any;
  const d = w.document as Document;
  const errors: string[] = [];
  let pushCount = 0;
  let replaceCount = 0;
  try {
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {};
    w.Element.prototype.scrollTo = function () {};
    w.Element.prototype.scrollIntoView = function () {};
    const log = w.console.error.bind(w.console);
    w.console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); log(...args); };
    w.addEventListener('error', (event: any) => { errors.push('uncaught: ' + String(event?.message ?? event)); });
    w.addEventListener('unhandledrejection', (event: any) => { errors.push('unhandled rejection: ' + String(event?.reason)); });
    const push = w.history.pushState.bind(w.history);
    w.history.pushState = (...args: any[]) => { pushCount += 1; return push(...args); };
    // Counted so a redirect loop shows up as a number instead of a timeout.
    const replace = w.history.replaceState.bind(w.history);
    w.history.replaceState = (...args: any[]) => { replaceCount += 1; return replace(...args); };

    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    w.fetch = async (input: any) => {
      const url = String(input);
      if (url.endsWith('/auth/state')) return reply({ mode: 'ready', authed: false, user: null, salt: '', iters: 1 });
      if (url.endsWith('/tree')) return reply({ spaces: fixture.spaces, pages: fixture.pages });
      const slug = decodeURIComponent((url.split('/pages/').pop() || '').split('?')[0]);
      const found = fixture.pages.find(page => page.slug === slug);
      if (!found) return { ok: false, status: 404, json: async () => ({ error: '页面不存在' }) };
      return reply({ ...found, content: `# ${found.title}\n\n正文 ${found.slug}` });
    };

    w.eval(bundle);
  } catch (error) {
    // A stack overflow here means the walk never terminated; close the window so the child can
    // report the failure instead of lingering on JSDOM's animation timers.
    dom.window.close();
    throw error;
  }

  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const click = (target: Element | null, label: string): void => {
    assert.ok(target, `missing element to click: ${label}`);
    target!.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  };

  const waitForSlug = (slug: string) => waitFor(() => slugChip(d) === '#' + slug, `page ${slug} to render`);

  await waitFor(() => !!d.querySelector('#article .slug-chip') || !!d.querySelector('.space-row'), 'the first render');
  return { dom, w, d, errors, click, waitFor, waitForSlug, pushes: () => pushCount, replaces: () => replaceCount };
}

/* ---------------------------------------------------------------- child scenarios */

/** Self-reference: `self.parent === 'self'`. */
async function scenarioSelf(): Promise<void> {
  const booted = await bootUi(CYCLIC, '/docs/self');
  try {
    const { w, d, errors } = booted;
    assert.equal(w.location.pathname, '/docs/self', 'a self-referencing page keeps its own finite path');
    assert.equal(slugChip(d), '#self', 'the article renders instead of freezing');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Self'], 'the trail stops before it repeats the page');
    assert.deepEqual(crumbLinks(d), ['/docs'], 'only the space is a real ancestor');
    assertFiniteTrail(d, CYCLIC, 'self reference');
    assert.match((d.querySelector('#article')?.textContent || ''), /正文 self/, 'the Markdown body still renders');

    // The sidebar builds one link per page and must survive the cycle in the data.
    const rows = [...d.querySelectorAll('.tree-row')] as HTMLElement[];
    assert.ok(rows.length > 0, 'the sidebar still lists the space');
    assert.ok(rows.length <= CYCLIC.pages.length, `the sidebar never duplicates rows, got ${rows.length}`);
    assert.ok(rows.filter(row => row.dataset.slug === 'self').length <= 1, 'a cyclic page appears at most once');

    // Interaction: a sibling page opens, and history returns to the cyclic one.
    booted.click(d.querySelector('#page-list a.page-item[href="/docs/safe"]'), 'sidebar row Safe');
    await booted.waitForSlug('safe');
    assert.equal(w.location.pathname, '/docs/safe');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Safe']);
    w.history.back();
    await booted.waitFor(() => w.location.pathname === '/docs/self' && slugChip(d) === '#self', 'going back to the self-referencing page');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Self']);

    // Search walks every page, cyclic ones included, and publishes their canonical path.
    const search = d.querySelector('#search') as HTMLInputElement;
    const searchFor = async (text: string) => {
      search.value = text;
      search.dispatchEvent(new w.Event('input', { bubbles: true }));
      await booted.waitFor(() => (d.querySelector('#count-hint')?.textContent || '').startsWith('匹配'), `search results for ${text}`);
      return [...d.querySelectorAll('#page-list a.page-item')].map(link => link.getAttribute('href'));
    };
    assert.deepEqual(await searchFor('self'), ['/docs/self'], 'search finds the self-referencing page by its own path');
    // Each member of the cycle resolves to the one canonical path the walk settles on, and both
    // are three segments deep rather than an ever-growing chain.
    assert.deepEqual(await searchFor('ping'), ['/docs/pong/ping'], 'search resolves one half of the cycle to a finite path');
    assert.deepEqual(await searchFor('pong'), ['/docs/ping/pong'], 'search resolves the other half to a finite path');
    assert.deepEqual(await searchFor('gamma'), ['/docs/alpha/beta/gamma'], 'search keeps full chains for ordinary pages');
    search.value = '';
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    await booted.waitFor(() => (d.querySelector('#count-hint')?.textContent || '').includes(`${CYCLIC.pages.length} 页`), 'the full tree again');
    assertNoRunaway(errors, 'self reference');
  } finally {
    booted.dom.window.close();
  }
}

/** Two-page cycle: `ping.parent === 'pong'`, `pong.parent === 'ping'`. */
async function scenarioPair(): Promise<void> {
  const booted = await bootUi(CYCLIC, '/docs/ping');
  try {
    const { w, d, errors } = booted;
    // The deep link cannot be satisfied (ping's parent is pong, which the URL omits), so the client
    // redirects once to the canonical chain. Terminating at all is the property under test.
    assert.equal(w.location.pathname, '/docs/pong/ping', 'a deep link into a cycle resolves once to a finite path');
    assert.equal(booted.replaces(), 1, 'the redirect is a single replaceState, not a loop');

    // A junk URL that repeats the cycle must also settle in one step, not grow the path.
    const deep = await bootUi(CYCLIC, '/docs/ping/pong/ping/pong');
    try {
      assert.equal(deep.w.location.pathname, '/docs/pong/ping', 'a repeated cycle collapses to the canonical path');
      assert.equal(deep.replaces(), 1, 'collapsing takes one replaceState');
      assert.equal(deep.w.history.length, 1, 'no history entries are appended while resolving');
      assert.deepEqual(crumbTitles(deep.d), ['Docs', 'Pong', 'Ping'], 'the collapsed path still renders the same trail');
      assertFiniteTrail(deep.d, CYCLIC, 'repeated cycle');
    } finally {
      deep.dom.window.close();
    }
    assert.equal(slugChip(d), '#ping');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Pong', 'Ping']);
    assert.deepEqual(crumbLinks(d), ['/docs', '/docs/ping/pong']);
    assertFiniteTrail(d, CYCLIC, 'two-page cycle');

    // The cyclic ancestor stays clickable, so following it repeatedly must settle each time.
    const historyBefore = w.history.length;
    for (let round = 1; round <= 3; round += 1) {
      booted.click(d.querySelector('#article .crumbs a[href="/docs/ping/pong"]'), `cyclic breadcrumb, round ${round}`);
      await booted.waitFor(() => w.location.pathname === '/docs/pong/ping' && slugChip(d) === '#ping', `round ${round} to settle`);
      assert.deepEqual(crumbTitles(d), ['Docs', 'Pong', 'Ping'], `round ${round} keeps the same trail`);
      assertFiniteTrail(d, CYCLIC, `two-page cycle round ${round}`);
      assert.equal(d.querySelectorAll('#article .crumbs').length, 1, `round ${round} replaces the trail instead of appending`);
      assert.equal(d.querySelectorAll('#article').length, 1);
    }
    assert.ok(w.history.length - historyBefore <= 3, 'each hop adds at most one history entry, never a runaway');
    assert.ok(booted.pushes() <= 3, `each hop pushes at most one entry, got ${booted.pushes()}`);

    // With the cycle loaded the rest of the UI keeps working.
    booted.click(d.querySelector('#page-list a.page-item[href="/docs/safe"]'), 'sidebar row Safe');
    await booted.waitForSlug('safe');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Safe']);
    booted.click(d.querySelector('.brand'), 'the home link');
    await booted.waitFor(() => w.location.pathname === '/' && !!d.querySelector('.space-row'), 'the space overview');
    assert.ok(d.querySelector('.space-row'), 'the overview renders after visiting a cycle');
    assertNoRunaway(errors, 'two-page cycle');
  } finally {
    booted.dom.window.close();
  }
}

/** Control: an ordinary chain must behave exactly as before, including nesting and history. */
async function scenarioChain(): Promise<void> {
  const booted = await bootUi(NORMAL, '/docs/alpha/beta/gamma');
  try {
    const { w, d, errors } = booted;
    assert.equal(w.location.pathname, '/docs/alpha/beta/gamma', 'a valid deep link is kept as-is');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Alpha', 'Beta', 'Gamma']);
    assert.deepEqual(crumbLinks(d), ['/docs', '/docs/alpha', '/docs/alpha/beta']);
    assert.match((d.querySelector('#article')?.textContent || ''), /正文 gamma/, 'the leaf renders');

    const row = (slug: string) => d.querySelector(`.tree-row[data-slug="${slug}"]`) as HTMLElement | null;
    assert.equal(row('safe')?.dataset.depth, '0', 'a root page sits at depth 0');
    assert.equal(row('alpha')?.dataset.depth, '0');
    assert.equal(row('beta')?.dataset.depth, '1');
    assert.equal(row('beta')?.dataset.parent, 'alpha', 'the sidebar keeps parent links');
    assert.equal(row('gamma')?.dataset.depth, '2', 'the chain is nested, not flattened');
    assert.equal(row('gamma')?.dataset.parent, 'beta');
    assert.ok(row('gamma')?.classList.contains('is-active'), 'the open page is highlighted');

    // Breadcrumb navigation and back/forward still work on an acyclic chain.
    booted.click(d.querySelector('#article .crumbs a[href="/docs/alpha/beta"]'), 'breadcrumb Beta');
    await booted.waitForSlug('beta');
    assert.equal(w.location.pathname, '/docs/alpha/beta');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Alpha', 'Beta']);

    booted.click(d.querySelector('#page-list a.page-item[href="/docs/safe"]'), 'sidebar row Safe');
    await booted.waitForSlug('safe');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Safe']);

    w.history.back();
    await booted.waitFor(() => w.location.pathname === '/docs/alpha/beta' && slugChip(d) === '#beta', 'history.back to Beta');
    w.history.back();
    await booted.waitFor(() => w.location.pathname === '/docs/alpha/beta/gamma' && slugChip(d) === '#gamma', 'history.back to Gamma');
    assert.deepEqual(crumbTitles(d), ['Docs', 'Alpha', 'Beta', 'Gamma'], 'history restores the full chain');
    assertFiniteTrail(d, NORMAL, 'normal chain');
    assertNoRunaway(errors, 'normal chain');
  } finally {
    booted.dom.window.close();
  }
}

/**
 * Deliberately frozen child: the parent must kill it instead of waiting forever. This is the only
 * assertion that proves the isolation works, and it fails loudly if the watchdog is ever weakened.
 */
async function scenarioSpin(): Promise<void> {
  let spins = 0;
  for (;;) {
    spins += 1;
    if (spins < 0) throw new Error('unreachable');
  }
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  self: scenarioSelf,
  pair: scenarioPair,
  chain: scenarioChain,
  spin: scenarioSpin,
};

/* ---------------------------------------------------------------- parent: spawn + watchdog */

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const OUTPUT_LIMIT = 8_000;

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT ? '…' + text.slice(-OUTPUT_LIMIT) : text;
}

function runChild(scenario: string, timeoutMs: number, bundlePath: string): Promise<ChildResult> {
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(process.execPath, [__filename], {
      cwd: ROOT,
      env: { ...process.env, DOCLIGHT_CYCLE_CHILD: scenario, DOCLIGHT_CYCLE_BUNDLE: bundlePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };
    // SIGKILL, not SIGTERM: a process spinning in JavaScript never runs a signal handler.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* the child may already be gone */ }
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', chunk => { stdout = clip(stdout + chunk); });
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr = clip(stderr + chunk); });
    child.on('error', error => {
      stderr = clip(stderr + '\nfailed to spawn the child: ' + error.message);
      settle(null, null);
    });
    child.on('close', (code, signal) => settle(code, signal));
  });
}

function assertChildPassed(result: ChildResult, scenario: string): void {
  const details = ['stdout:', result.stdout.trim() || '(empty)', 'stderr:', result.stderr.trim() || '(empty)'].join('\n');
  if (result.timedOut) {
    throw new Error(
      `scenario "${scenario}" blocked the event loop for ${result.durationMs} ms and was killed.\n` +
      'That is the failure this test exists for: a page cycle is being walked without a visited set ' +
      '(check chainOf and revealPath in src/client/app.ts).\n' + details,
    );
  }
  if (result.code !== 0) {
    throw new Error(`scenario "${scenario}" exited with code ${result.code} (signal ${result.signal}).\n${details}`);
  }
  if (!result.stdout.includes(CHILD_OK + ' ' + scenario)) {
    throw new Error(`scenario "${scenario}" finished without its sentinel line.\n${details}`);
  }
}

/* ---------------------------------------------------------------- entry point */

async function main(): Promise<void> {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-page-cycle-'));
  const bundlePath = path.join(bundleDir, 'app.bundle.js');
  try {
    // Build once in the parent: children only read the file, so no second esbuild service is
    // started inside a process the watchdog may have to kill.
    const built = buildSync({ entryPoints: [path.join(ROOT, 'src/client/app.ts')], bundle: true, write: false, platform: 'browser', format: 'iife' });
    fs.writeFileSync(bundlePath, built.outputFiles[0].text);

    // First prove the watchdog: a child whose loop is blocked must be killed, not awaited.
    const stuck = await runChild('spin', SPIN_TIMEOUT_MS, bundlePath);
    assert.equal(stuck.timedOut, true, 'the watchdog kills a child whose event loop is blocked');
    assert.notEqual(stuck.code, 0, 'a killed child never reports success');
    assert.doesNotMatch(stuck.stdout, new RegExp(CHILD_OK), 'a blocked scenario prints no sentinel');
    console.log(`  ✓ watchdog: a blocked child is killed after ${stuck.durationMs} ms`);

    const expected = ['self', 'pair', 'chain'] as const;
    for (const scenario of expected) {
      const result = await runChild(scenario, CHILD_TIMEOUT_MS, bundlePath);
      assertChildPassed(result, scenario);
      console.log(`  ✓ ${scenario} (${result.durationMs} ms)`);
    }
    console.log('page cycle UI assertions passed');
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

if (CHILD_SCENARIO) {
  const scenario = SCENARIOS[CHILD_SCENARIO];
  if (!scenario) {
    // Write synchronously so the parent always sees the message, then leave.
    fs.writeSync(2, `unknown child scenario: ${CHILD_SCENARIO}\n`);
    process.exit(2);
  }
  // If something nonessential (a stray JSDOM timer) outlives the assertions, exit anyway: the
  // parent distinguishes "printed the sentinel" from "never got there".
  const safetyExit = setTimeout(() => process.exit(0), 2_000);
  safetyExit.unref();
  scenario().then(
    () => { fs.writeSync(1, `${CHILD_OK} ${CHILD_SCENARIO}\n`); },
    error => {
      fs.writeSync(2, `scenario ${CHILD_SCENARIO} failed\n${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exit(1);
    },
  );
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
