/*
 * Layered configuration regression tests.
 *
 * Configuration resolves as built-in defaults < doclight.toml < environment. The
 * dangerous failures are all silent: a boolean flattened to the string "false" turns
 * strict mode *on*, an invalid port swallowed by `|| 4173` keeps the wrong port, and an
 * empty override that falls back to the file makes it impossible to disable a setting
 * temporarily. Every case below asserts the resolved value, not just that parsing
 * succeeded, so a regression cannot hide behind a working default.
 *
 * The file is always addressed explicitly through `configPath` (a throwaway temp file),
 * so a real doclight.toml in the repository cannot leak into these assertions.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureConfigFile, CONFIG_TEMPLATE, CONFIG_KEYS } from '../config.js';

const root = path.resolve(__dirname, '../..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-config-test-'));
const file = path.join(tmpRoot, 'doclight.toml');

function write(text: string): string {
  fs.writeFileSync(file, text);
  return file;
}

function load(env: Record<string, string> = {}) {
  return loadConfig({ env: env as NodeJS.ProcessEnv, root: tmpRoot, configPath: file });
}

function fails(env: Record<string, string>, pattern: RegExp, label: string): void {
  assert.throws(() => load(env), pattern, label);
}

/* ---------- 1. Defaults when the file does not exist ---------- */

fs.rmSync(file, { force: true });
const defaults = load();
assert.equal(defaults.port, 4173, '默认端口应为 4173');
assert.equal(defaults.host, undefined, '默认应绑定全部网卡');
assert.equal(defaults.strictPort, false, '默认不进入严格端口模式');
assert.equal(defaults.dataDir, path.join(tmpRoot, 'data'), '默认数据目录应位于项目根下');
assert.equal(defaults.icp, '', '默认备案号应为空');

/* ---------- 2. TOML values are read ---------- */

write(`
port = 4711
host = "127.0.0.1"
strictPort = true
dataDir = "${tmpRoot}/custom"
icp = "浙ICP备12345678号-1"
copyright = "© 2026 Mooling"
`);
const fromFile = load();
assert.equal(fromFile.port, 4711, 'TOML 端口应生效');
assert.equal(fromFile.host, '127.0.0.1', 'TOML 监听地址应生效');
assert.equal(fromFile.strictPort, true, 'TOML strictPort=true 应生效');
assert.equal(fromFile.dataDir, path.join(tmpRoot, 'custom'), 'TOML dataDir 应生效');
assert.equal(fromFile.icp, '浙ICP备12345678号-1', 'TOML 中文备案号应原样保留');
assert.equal(fromFile.copyright, '© 2026 Mooling', 'TOML 版权行应保留空格与符号');

/* ---------- 3. Environment overrides the file ---------- */

const overridden = load({ PORT: '4712', DOCLIGHT_ICP: '京ICP备1号' });
assert.equal(overridden.port, 4712, '环境变量应覆盖 TOML 端口');
assert.equal(overridden.icp, '京ICP备1号', '环境变量应覆盖 TOML 备案号');
assert.equal(overridden.host, '127.0.0.1', '未被环境变量覆盖的键仍应来自 TOML');
assert.equal(overridden.copyright, '© 2026 Mooling', '未覆盖的键不应受影响');

/* ---------- 4. Explicit empty environment variable clears the value ---------- */

const cleared = load({ DOCLIGHT_ICP: '', DOCLIGHT_COPYRIGHT: '' });
assert.equal(cleared.icp, '', '空串环境变量应清空备案号，而非回退 TOML');
assert.equal(cleared.copyright, '', '空串环境变量应清空版权行');
assert.equal(cleared.port, 4711, '清空其它键不应影响端口');

/* ---------- 5. strictPort is never stringified ---------- */

fs.writeFileSync(file, 'strictPort = false\n');
const boolFalse = load();
assert.equal(boolFalse.strictPort, false, 'TOML false 不应被当成真值');

// Environment form follows the existing "present means enabled" rule, with "" disabled.
assert.equal(load({ DOCLIGHT_STRICT_PORT: '1' }).strictPort, true, 'env=1 应启用严格模式');
assert.equal(load({ DOCLIGHT_STRICT_PORT: '0' }).strictPort, true, 'env 非空即启用（沿用旧语义）');
assert.equal(load({ DOCLIGHT_STRICT_PORT: '' }).strictPort, false, 'env 空串应视为关闭');

/* ---------- 6. Invalid ports and types are rejected, not silently defaulted ---------- */

fails({ PORT: 'abc' }, /端口/, '非法端口字符串应报错');
fails({ PORT: '0' }, /端口/, '端口 0 应报错而非静默变 4173');
fails({ PORT: '99999' }, /端口/, '越界端口应报错');

write('port = "abc"\n');
fails({}, /port/, 'TOML 中字符串端口应报错并指出键名');
write('port = 0\n');
fails({}, /port/, 'TOML 端口 0 应报错');
write('port = 99999\n');
fails({}, /port/, 'TOML 越界端口应报错');
write('strictPort = "false"\n');
fails({}, /strictPort/, 'TOML 字符串 strictPort 应报类型错误');
write('icp = 12345\n');
fails({}, /icp/, '备案号写成数字应报类型错误');

/* ---------- 7. A malformed file aborts with its line number ---------- */

write('ok = 1\nbad = = 2\n');
try {
  load();
  assert.fail('非法 TOML 应抛出异常');
} catch (err) {
  const message = (err as Error).message;
  assert.match(message, /第 2 行/, '解析错误信息应包含行号');
}

/* ---------- 8. DOCLIGHT_CONFIG selects the file; default is <root>/doclight.toml ---------- */

const altFile = path.join(tmpRoot, 'alt.toml');
fs.writeFileSync(altFile, 'port = 4800\n');
const viaEnv = loadConfig({ env: { DOCLIGHT_CONFIG: altFile } as NodeJS.ProcessEnv, root: tmpRoot });
assert.equal(viaEnv.port, 4800, 'DOCLIGHT_CONFIG 指向的文件应被读取');

// Default path is <root>/doclight.toml; with no file there it silently yields defaults.
const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-config-clean-'));
const fallbackPath = loadConfig({ env: {} as NodeJS.ProcessEnv, root: cleanRoot });
assert.equal(fallbackPath.port, 4173, '未设置 DOCLIGHT_CONFIG 时应回退默认路径且不报错');
assert.equal(
  loadConfig({ env: {} as NodeJS.ProcessEnv, root: cleanRoot }).dataDir,
  path.join(cleanRoot, 'data'),
  '默认配置路径不得位于 dataDir 之下（避免自引用）',
);
fs.rmSync(cleanRoot, { recursive: true, force: true });

/* ---------- 9. The starter file is seeded once, and cannot change behaviour ---------- */

const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-config-seed-'));
const seedFile = path.join(seedRoot, 'doclight.toml');

// The template documents every key the loader accepts; a new option added without
// updating the template fails here.
for (const key of CONFIG_KEYS) {
  assert.match(CONFIG_TEMPLATE, new RegExp(`^#${key} =`, 'm'), `模板应包含配置项 ${key}`);
}

// Seeding fills the default path and reports it.
assert.equal(ensureConfigFile({ env: {} as NodeJS.ProcessEnv, root: seedRoot }), seedFile, '首次运行应在默认路径生成模板');
assert.ok(fs.existsSync(seedFile), '生成后文件应存在');

// The generated file must resolve to the built-in defaults: every key is commented out.
const seeded = loadConfig({ env: {} as NodeJS.ProcessEnv, root: seedRoot });
assert.equal(seeded.port, 4173, '模板不得激活任何端口值');
assert.equal(seeded.strictPort, false, '模板不得启用严格端口模式');
assert.equal(seeded.dataDir, path.join(seedRoot, 'data'), '模板不得覆盖默认数据目录');
assert.equal(seeded.icp, '', '模板不得写入备案号');
assert.equal(seeded.copyright, '', '模板不得写入版权行');

// An existing file is never overwritten, so local edits survive a restart.
fs.writeFileSync(seedFile, 'port = 4900\n');
assert.equal(ensureConfigFile({ env: {} as NodeJS.ProcessEnv, root: seedRoot }), null, '已存在配置文件时不应再次生成');
assert.equal(fs.readFileSync(seedFile, 'utf8'), 'port = 4900\n', '已有的本地配置不得被覆盖');

// An explicit DOCLIGHT_CONFIG is honoured, and no stray file appears at the default path.
fs.rmSync(seedFile, { force: true });
const elsewhere = path.join(seedRoot, 'nested', 'custom.toml');
assert.equal(
  ensureConfigFile({ env: { DOCLIGHT_CONFIG: elsewhere } as NodeJS.ProcessEnv, root: seedRoot }),
  null,
  'DOCLIGHT_CONFIG 生效时不应生成默认路径文件',
);
assert.equal(fs.existsSync(seedFile), false, 'DOCLIGHT_CONFIG 生效时不得在默认路径留下文件');

// An unwritable root (the read-only Nix store) must not break startup.
const roRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-config-ro-'));
fs.chmodSync(roRoot, 0o500);
const roResult = ensureConfigFile({ env: {} as NodeJS.ProcessEnv, root: roRoot });
fs.chmodSync(roRoot, 0o700);
assert.equal(roResult, null, '根目录不可写时应静默跳过而非抛错');

fs.rmSync(seedRoot, { recursive: true, force: true });
fs.rmSync(roRoot, { recursive: true, force: true });

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('config assertions passed');
