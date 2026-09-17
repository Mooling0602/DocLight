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
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const serverEntry = path.join(root, 'dist', 'server.js');

interface StartedServer {
  port: number;
  stop: () => void;
}

/** Boot dist/server.js on a scraped port and resolve once it is listening. */
function startServer(env: NodeJS.ProcessEnv): Promise<StartedServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-http-test-'));
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: { ...process.env, PORT: '4700', DOCLIGHT_DATA_DIR: dataDir, ...env },
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

  console.log('filing footer HTTP assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
