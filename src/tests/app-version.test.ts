/* The shell's sidebar footer must show the version of the package that is actually running. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const serverEntry = path.join(root, 'dist', 'server.js');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-version-test-'));
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '4710',
      DOCLIGHT_DATA_DIR: dataDir,
      DOCLIGHT_CONFIG: path.join(dataDir, 'absent.toml'),
      DOCLIGHT_ICP: '',
      DOCLIGHT_POLICE: '',
      DOCLIGHT_COPYRIGHT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('server did not start in time:\n' + output)), 15000);
      const once = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      };
      child.stdout.on('data', once);
      child.stderr.on('data', once);
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited early with code ${code}:\n${output}`)); });
    });
    for (const route of ['/', '/spaces', '/default/welcome']) {
      const html = await (await fetch(`http://127.0.0.1:${port}${route}`)).text();
      assert.ok(html.includes(`<span id="app-version">v${version}</span>`), `${route} must render the package version`);
      assert.ok(!html.includes('DocLight v1.0'), `${route} must not keep the stale placeholder`);
    }
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log('app version assertions passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
