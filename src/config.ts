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
