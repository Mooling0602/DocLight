/**
 * DocLight - layered configuration
 *
 * Configuration comes from three sources, later ones overriding earlier ones:
 *
 *   built-in defaults  <  TOML file  <  environment variables
 *
 * The TOML file is the canonical carrier of configuration; environment variables are
 * a temporary override for one-off runs. An override only wins for the exact keys it
 * sets — every other key keeps its TOML (or default) value.
 *
 * A key counts as set when the variable *exists*, even if it is empty: an explicitly
 * empty string clears the value instead of falling back to the file. This is what
 * lets an operator switch off the filing footer without editing the file.
 *
 * TOML is typed and the environment is not, so the two layers are merged as native
 * values (number / boolean / string) and validated here. Nothing is ever round-tripped
 * through `String()`: that would turn `strictPort = false` into the truthy string
 * "false" and `port = 0` into the truthy "0".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'smol-toml';

/** The compiled module lives in dist/, so the project root is one level up. */
const DEFAULT_ROOT = path.resolve(__dirname, '..');

/** Keys accepted in the TOML file, mapped to their environment overrides. */
const STRING_KEYS = ['host', 'dataDir', 'icp', 'icpUrl', 'police', 'policeUrl', 'copyright'] as const;
type StringKey = (typeof STRING_KEYS)[number];

const ENV_KEYS: Record<string, string> = {
  port: 'PORT',
  host: 'DOCLIGHT_HOST',
  strictPort: 'DOCLIGHT_STRICT_PORT',
  dataDir: 'DOCLIGHT_DATA_DIR',
  icp: 'DOCLIGHT_ICP',
  icpUrl: 'DOCLIGHT_ICP_URL',
  police: 'DOCLIGHT_POLICE',
  policeUrl: 'DOCLIGHT_POLICE_URL',
  copyright: 'DOCLIGHT_COPYRIGHT',
};

const KNOWN_KEYS = Object.keys(ENV_KEYS);

/** Exported so tests can assert the starter template documents every known key. */
export const CONFIG_KEYS = KNOWN_KEYS;

export interface AppConfig {
  port: number;
  /** Bind address; undefined means every interface. */
  host: string | undefined;
  strictPort: boolean;
  /** Absolute path to the writable data directory. */
  dataDir: string;
  icp: string;
  icpUrl: string;
  police: string;
  policeUrl: string;
  copyright: string;
}

/** Where a value came from; only used to make error messages actionable. */
export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  root?: string;
  /** Override the file location, bypassing DOCLIGHT_CONFIG (used by tests). */
  configPath?: string;
}

/** Parse a port from either layer. Rejecting here is deliberate: `|| 4173` would turn
 *  an invalid or zero port into a silent default, hiding the operator's mistake. */
function coercePort(value: unknown, source: string): number {
  let port: number;
  if (typeof value === 'number') {
    port = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!/^\d+$/.test(text)) throw new Error(`${source}: 端口必须是 1–65535 的整数，收到 "${value}"`);
    port = Number(text);
  } else {
    throw new Error(`${source}: 端口必须是整数，收到 ${typeof value}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source}: 端口 ${port} 超出 1–65535 范围`);
  }
  return port;
}

/** Resolve the configuration file: DOCLIGHT_CONFIG when set, else <root>/doclight.toml.
 *  The default deliberately sits outside the data directory so there is no chicken-and-egg
 *  problem between "where is the file" and a `dataDir` defined inside it. */
export function resolveConfigPath(env: NodeJS.ProcessEnv, root: string, override?: string): string {
  if (override) return override;
  const explicit = env.DOCLIGHT_CONFIG;
  if (explicit !== undefined && explicit.trim() !== '') return path.resolve(explicit);
  return path.join(root, 'doclight.toml');
}

/**
 * Write the starter configuration file if the operator has none yet, so the available
 * options are discoverable in place instead of only in the README.
 *
 * Only <root>/doclight.toml is ever seeded. An explicit DOCLIGHT_CONFIG means the
 * operator already manages a file — or deliberately points at one that does not exist
 * yet — and a chosen path must never be created behind their back (a typo would
 * otherwise leave a stray file next to the intended one). An existing file is never
 * touched, so local edits survive restarts.
 *
 * Seeding is best-effort and must not break startup: under `nix run` the project root is
 * a read-only store path, where the write simply fails. Returns the path actually
 * written, or null when nothing was created.
 */
export function ensureConfigFile(options: { env?: NodeJS.ProcessEnv; root?: string } = {}): string | null {
  const env = options.env || process.env;
  const root = options.root || DEFAULT_ROOT;

  const explicit = env.DOCLIGHT_CONFIG;
  if (explicit !== undefined && explicit.trim() !== '') return null;

  const file = path.join(root, 'doclight.toml');
  if (fs.existsSync(file)) return null;
  try {
    // `wx` makes creation atomic: a file that appeared between the check and the write
    // is never overwritten.
    fs.writeFileSync(file, CONFIG_TEMPLATE, { flag: 'wx' });
    return file;
  } catch {
    // Unwritable root (read-only store, missing directory, no permission) or a racing
    // creator that won the exclusivity check: startup continues with built-in defaults.
    return null;
  }
}

/**
 * The starter file written on first run. Every key is commented out on purpose: the
 * file then parses to an empty table, so its mere existence cannot change behaviour
 * (a template that uncommented its defaults would pin today's defaults into every new
 * install, and later default changes would stop reaching them).
 *
 * `config.test.ts` asserts that each known key appears here, so adding a config option
 * without documenting it in the template fails the suite.
 */
export const CONFIG_TEMPLATE = `# DocLight 配置文件
#
# 默认读取本文件（项目根/doclight.toml）；也可用 DOCLIGHT_CONFIG 指向别处。
# 优先级：内置默认值 < 本文件 < 环境变量。
# 本文件是正式载体，环境变量只作临时覆盖（变量存在即生效，空串表示清空）。
#
# 下面的键全部以注释给出，即当前全部使用内置默认值。取消注释并改写即可生效；
# 未取消注释的键不会覆盖默认值。改完需重启服务。

# 起始端口；默认 4173，被占用时自动向后探测。必须是 1–65535 的整数。
#port = 4173

# 监听地址；默认监听全部网卡，设 "127.0.0.1" 可只允许本机访问。
#host = "127.0.0.1"

# true 时端口被占用直接报错退出，不再向后探测（默认 false）。
#strictPort = false

# 数据目录（存放 pages/*.md、spaces.json、auth.json）；默认 <项目根>/data。
# 需持久化或受保护时改为绝对路径，例如 "/var/lib/doclight"。
#dataDir = "/var/lib/doclight"

# 网站备案号，悬挂在页面底部；留空（默认）则不显示。
#icp = "浙ICP备12345678号-1"

# 备案号链接；不设置时按内置规则指向工信部备案管理系统。
#icpUrl = "https://beian.miit.gov.cn/"

# 公安联网备案号（可选）。
#police = "京公网安备11010502030123号"

# 公安备案号链接；不设置时按备案号中的数字段自动生成查询链接。
#policeUrl = ""

# 版权行（可选），显示在备案号左侧。
#copyright = "© 2026 Mooling"
`;

/** Read and validate the TOML file. A missing file is not an error (first run must work
 *  out of the box); a malformed one is fatal and reports its line number. */
function readToml(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    return parse(text) as Record<string, unknown>;
  } catch (err) {
    const e = err as { message?: string; line?: number };
    const line = typeof e.line === 'number' ? `（第 ${e.line} 行）` : '';
    throw new Error(`配置文件解析失败 ${file}${line}: ${e.message || err}`);
  }
}

/** Validate one TOML value against the type this key expects. */
function validateTomlValue(key: string, value: unknown): string | number | boolean {
  if (key === 'port') return coercePort(value, `配置项 port`);
  if (key === 'strictPort') {
    if (typeof value !== 'boolean') throw new Error(`配置项 strictPort 必须是布尔值，收到 ${typeof value}`);
    return value;
  }
  if ((STRING_KEYS as readonly string[]).includes(key)) {
    if (typeof value !== 'string') throw new Error(`配置项 ${key} 必须是字符串，收到 ${typeof value}`);
    return value;
  }
  throw new Error(`未知配置项 ${key}`);
}

/**
 * Load the effective configuration. Exported for tests, which pass an explicit `env`,
 * `root` and `configPath` so a stray doclight.toml in the repository cannot leak in.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env || process.env;
  const root = options.root || DEFAULT_ROOT;
  const file = resolveConfigPath(env, root, options.configPath);

  const raw = readToml(file);
  const merged: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_KEYS.includes(key)) {
      console.warn(`· 忽略未知配置项 ${key}（${file}）`);
      continue;
    }
    merged[key] = validateTomlValue(key, value);
  }

  // Environment overrides: an existing variable always wins, even when empty.
  const has = (key: string) => Object.prototype.hasOwnProperty.call(env, ENV_KEYS[key]);
  if (has('port')) merged.port = coercePort(env.PORT, '环境变量 PORT');
  if (has('strictPort')) merged.strictPort = env.DOCLIGHT_STRICT_PORT !== '';
  for (const key of STRING_KEYS) {
    if (has(key)) merged[key] = String(env[ENV_KEYS[key]]);
  }

  const str = (key: StringKey, fallback = ''): string =>
    typeof merged[key] === 'string' ? (merged[key] as string) : fallback;

  const dataDirValue = str('dataDir');
  return {
    port: typeof merged.port === 'number' ? merged.port : 4173,
    host: str('host') || undefined,
    strictPort: merged.strictPort === true,
    dataDir: dataDirValue ? path.resolve(dataDirValue) : path.join(root, 'data'),
    icp: str('icp'),
    icpUrl: str('icpUrl'),
    police: str('police'),
    policeUrl: str('policeUrl'),
    copyright: str('copyright'),
  };
}
