/*
 * HTTP-level filing footer test.
 *
 * beian.test.ts asserts the renderer in isolation. What actually matters for
 * compliance is the raw bytes of the served response, which only an end-to-end request
 * can prove: the footer has to survive the static handler, the SPA fallback and the
 * "no filing configured" path without leaving the internal marker comment behind.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const serverEntry = path.join(root, 'dist', 'server.js');

interface StartedServer {
  port: number;
  stop: () => void;
}

/**
 * Filing variables that must not leak from the parent process into the child. A
 * DOCLIGHT_ICP exported in the developer's shell or CI would otherwise turn the
 * "nothing configured" case into a configured one and fail the assertion.
 */
const FILING_ENV_VARS = [
  'DOCLIGHT_ICP',
  'DOCLIGHT_ICP_URL',
  'DOCLIGHT_POLICE',
  'DOCLIGHT_POLICE_URL',
  'DOCLIGHT_COPYRIGHT',
] as const;

/** Boot dist/server.js on a scraped port and resolve once it is listening. */
function startServer(env: NodeJS.ProcessEnv): Promise<StartedServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-http-test-'));
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of FILING_ENV_VARS) delete baseEnv[key];
  // Point the config loader at a path that does not exist. Without this a doclight.toml
  // sitting in the repository root would be picked up (the default is <root>/doclight.toml)
  // and could configure filing info, turning the "nothing configured" case into a false
  // failure — the same class of leak the FILING_ENV_VARS scrub above guards against.
  const configPath = path.join(dataDir, 'absent.toml');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: { ...baseEnv, PORT: '4700', DOCLIGHT_DATA_DIR: dataDir, DOCLIGHT_CONFIG: configPath, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('server did not start in time:\n' + output));
    }, 15000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        port: Number(match[1]),
        stop: () => {
          child.kill();
          try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
        },
      });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}:\n${output}`));
    });
  });
}

/**
 * Send a hand-written request line and resolve with whatever the server sent back, or `null`
 * when the connection closed with no bytes (the signature of a process that died mid-request).
 * `fetch` cannot express these targets: it normalises or refuses them, so the only way to reach
 * the absolute-form parsing path is to speak HTTP directly.
 */
function rawRequest(port: number, requestLine: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const done = (value: string | null) => { socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => done(data || null));
    socket.on('connect', () => socket.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('error', () => done(data || null));
    socket.on('close', () => done(data || null));
  });
}

async function main(): Promise<void> {
  /* ---- No filing configured: the raw HTML must contain neither a footer nor a leftover marker ---- */
  const plain = await startServer({});
  try {
    const html = await (await fetch(`http://127.0.0.1:${plain.port}/`)).text();
    assert.ok(!html.includes('site-footer'), 'unconfigured site must not render a footer');
    assert.ok(!html.includes('DOCLIGHT_FOOTER'), 'marker comment must not leak into the response');
    // Deep links (SPA fallback) also get the injected shell
    const deep = await (await fetch(`http://127.0.0.1:${plain.port}/default/welcome`)).text();
    assert.ok(!deep.includes('site-footer'), 'fallback route must not render a footer either');
  } finally {
    plain.stop();
  }

  /* ---- Filing configured: the footer must appear in the raw HTML ---- */
  const filed = await startServer({
    DOCLIGHT_ICP: '浙ICP备12345678号-1',
    DOCLIGHT_POLICE: '京公网安备11010502030123号',
    DOCLIGHT_COPYRIGHT: '© 2026 Mooling',
  });
  try {
    const html = await (await fetch(`http://127.0.0.1:${filed.port}/`)).text();
    const bodyIndex = html.indexOf('<body');
    const footerIndex = html.indexOf('<footer id="site-footer"');
    assert.ok(footerIndex > bodyIndex, 'footer must be present in the raw HTML');
    assert.ok(html.includes('浙ICP备12345678号-1'), 'served HTML must contain the ICP number');
    assert.ok(html.includes('beian.miit.gov.cn'), 'ICP number must link to the MIIT portal');
    assert.ok(
      html.includes('https://beian.mps.gov.cn/#/query/webSearch?code=11010502030123'),
      'police number must link to its lookup page',
    );
    assert.ok(
      html.includes('src="https://beian.mps.gov.cn/web/assets/logo01.6189a29f.png"'),
      'police filing must render the official badge image',
    );
    assert.ok(html.includes('© 2026 Mooling'), 'copyright line must be preserved');
    assert.ok(!html.includes('DOCLIGHT_FOOTER'), 'marker comment must be consumed');
    // The footer sits inside <main>, before the end of the document — the page bottom required for compliance
    assert.ok(footerIndex < html.indexOf('</main>'), 'footer must sit at the bottom of the shell');
    assert.ok(footerIndex < html.indexOf('</body>'), 'footer must be inside the body');

    // Deep links are injected too (the same cached shell)
    const deep = await (await fetch(`http://127.0.0.1:${filed.port}/default/welcome`)).text();
    assert.ok(deep.includes('浙ICP备12345678号-1'), 'SPA fallback must carry the footer');
  } finally {
    filed.stop();
  }

  /* ---- A malformed URI must not kill the process ---- */
  // `decodeURIComponent` throws URIError on an escape such as `/%`. For /api/ routes that throw is
  // caught, but the static handler runs *outside* the request promise chain, so it escaped and the
  // process exited: a single request to any such path took the whole site down.
  const hardened = await startServer({});
  try {
    const bad = await fetch(`http://127.0.0.1:${hardened.port}/%`, { redirect: 'manual' }).catch(() => null);
    assert.ok(bad, '格式错误的 URL 应得到响应而不是断开连接');
    assert.equal(bad!.status, 400, '格式错误的转义应返回 400');
    // The decisive check: the server is still serving.
    const still = await fetch(`http://127.0.0.1:${hardened.port}/`);
    assert.equal(still.status, 200, '一次格式错误的请求不得让服务进程退出');

    // The same escape on an API route is contained by the request catch and answers with JSON.
    const apiBad = await fetch(`http://127.0.0.1:${hardened.port}/api/pages/%`).catch(() => null);
    assert.ok(apiBad, 'API 侧的格式错误转义也应得到响应');
    assert.equal(apiBad!.status, 500, 'API 侧的格式错误转义应返回 500');
    assert.equal((await fetch(`http://127.0.0.1:${hardened.port}/`)).status, 200, 'API 侧异常同样不得终止进程');
  } finally {
    hardened.stop();
  }

  /* ---- An absolute-form request target must not kill the process ---- */
  // `new URL(req.url, ...)` is the first line of `handler`, outside the promise chain: an
  // absolute-form target such as `GET http://[ HTTP/1.1` raises ERR_INVALID_URL and, uncaught,
  // exited the process. Browsers never send that form, but any raw socket can, so one such request
  // from a scanner took the whole site down. `fetch` cannot send it — hence the raw socket.
  const target = await startServer({});
  try {
    for (const requestLine of ['GET http://[ HTTP/1.1', 'GET http://[::1 HTTP/1.1', 'GET http://% HTTP/1.1']) {
      const response = await rawRequest(target.port, requestLine);
      assert.ok(response, `${requestLine} 应得到响应而不是断开连接`);
      assert.match(response!, /^HTTP\/1\.1 400 /, `${requestLine} 应返回 400`);
      const alive = await fetch(`http://127.0.0.1:${target.port}/`).catch(() => null);
      assert.equal(alive?.status, 200, `${requestLine} 之后服务仍应在运行`);
    }
    // The control: an ordinary origin-form target still succeeds on the same server.
    const ok = await rawRequest(target.port, 'GET / HTTP/1.1');
    assert.match(ok!, /^HTTP\/1\.1 200 /, '对照的普通请求应返回 200');
  } finally {
    target.stop();
  }

  /* ---- An unreadable asset must not kill the process ---- */
  // `fs.createReadStream(file).pipe(res)` had no 'error' listener, so an asset that becomes
  // unreadable under a live server (a permissions change, an I/O error) emitted an unhandled
  // 'error' and exited the process. The headers are already sent by the time the stream fails, so
  // the connection is destroyed; the requirement is only that the *server* survives. The
  // permission change is applied to a real asset, and skipped when the test itself can still read
  // it — that happens when the suite runs as root, where chmod cannot deny the server either.
  const asset = path.join(root, 'public', 'style.css');
  const originalMode = fs.statSync(asset).mode;
  const unreadable = await startServer({});
  try {
    fs.chmodSync(asset, 0o000);
    let denied = false;
    try { fs.readFileSync(asset); } catch { denied = true; }
    if (denied) {
      // The connection is destroyed mid-response, so the client may legitimately see no bytes at
      // all; what must not happen is the process exiting, which the follow-up request proves.
      await rawRequest(unreadable.port, 'GET /style.css HTTP/1.1');
      const alive = await fetch(`http://127.0.0.1:${unreadable.port}/`).catch(() => null);
      assert.equal(alive?.status, 200, '静态资源读取失败不得让服务进程退出');
    } else {
      console.log('· 跳过静态资源读取失败断言：当前用户可读 chmod 000 的文件（可能以 root 运行）');
    }
  } finally {
    fs.chmodSync(asset, originalMode);
    unreadable.stop();
  }

  console.log('filing footer HTTP assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
