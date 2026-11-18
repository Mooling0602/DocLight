/**
 * Regression coverage for the anonymous half of the auth protocol.
 *
 * The login flow hands a challenge to unauthenticated callers, so nothing a caller can reach
 * before proving knowledge of the password may carry the account name. These cases pin the
 * whole round trip down: first-run setup, anonymous state/challenge, proof login, guest
 * space unlock, and the session guard that still protects writes.
 */
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclight-auth-anon-'));
const user = 'siteowner';
const password = 'pw123456';
let child: ChildProcess | undefined;
let base = '';
let cookie = '';

async function start(): Promise<void> {
  const env = { ...process.env };
  for (const key of ['PORT', 'DOCLIGHT_HOST', 'DOCLIGHT_STRICT_PORT', 'DOCLIGHT_DATA_DIR']) delete env[key];
  child = spawn(process.execPath, [path.join(root, 'dist/server.js')], {
    cwd: root,
    env: { ...env, PORT: '4640', DOCLIGHT_DATA_DIR: dataDir, DOCLIGHT_CONFIG: path.join(dataDir, 'absent.toml') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const processChild = child;
  base = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('server startup timed out: ' + output)), 15000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    processChild.stdout!.on('data', receive);
    processChild.stderr!.on('data', receive);
    processChild.once('error', error => { clearTimeout(timer); reject(error); });
    processChild.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${output}`)); });
  });
}

async function stop(): Promise<void> {
  const running = child;
  child = undefined;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  await new Promise<void>(resolve => { running.once('exit', () => resolve()); running.kill(); });
}

/**
 * Issue one request. `withCookie` decides whether the stored session rides along; a `Set-Cookie`
 * response is always adopted, the way a browser does, so a signed-out client cannot stay logged in.
 */
async function request(endpoint: string, method = 'GET', body?: unknown, withCookie = true): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(withCookie && cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: response.status, text: await response.text() };
}

async function api(endpoint: string, method = 'GET', body?: unknown, withCookie = true): Promise<{ status: number; body: any; text: string }> {
  const result = await request(endpoint, method, body, withCookie);
  return { ...result, body: JSON.parse(result.text) };
}

const deriveKeyHex = (pass: string, salt: string, iters: number) =>
  pbkdf2Sync(pass, Buffer.from(salt, 'hex'), iters, 32, 'sha256').toString('hex');
const sign = (keyHex: string, nonce: string) =>
  createHmac('sha256', Buffer.from(keyHex, 'hex')).update(nonce).digest('hex');

/** Ask for a challenge and answer it, exactly as the browser client does. */
async function proof(pass = password): Promise<{ nonce: string; proof: string }> {
  const challenge = await api('auth/challenge', 'GET', undefined, false);
  assert.equal(challenge.status, 200);
  const { nonce, salt, iters } = challenge.body;
  return { nonce, proof: sign(deriveKeyHex(pass, salt, iters), nonce) };
}

/** No response reachable before authentication may mention the account name. */
function assertNoAccountName(text: string, label: string): void {
  assert.ok(!text.includes(user), `${label} must not expose the account name: ${text}`);
}

async function main(): Promise<void> {
  try {
    fs.cpSync(path.join(root, 'template'), dataDir, { recursive: true });
    await start();

    // A fresh install has no account yet: state asks for setup and the challenge is refused.
    const fresh = await api('auth/state', 'GET', undefined, false);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.mode, 'setup');
    assert.equal(fresh.body.authed, false);
    assert.equal(fresh.body.user, null);
    assert.equal(typeof fresh.body.salt, 'string');
    assert.equal(fresh.body.iters, 100000);
    const freshChallenge = await api('auth/challenge', 'GET', undefined, false);
    assert.equal(freshChallenge.status, 400);
    assert.equal(freshChallenge.body.needSetup, true);

    // Claiming the site creates the account and starts a session; the caller learns its own name.
    const setup = await api('auth/setup', 'POST', { user, ks: deriveKeyHex(password, fresh.body.salt, fresh.body.iters) });
    assert.equal(setup.status, 200);
    assert.equal(setup.body.ok, true);
    assert.equal(setup.body.user, user);
    assert.ok(cookie, 'setup must issue a session');
    const authed = await api('auth/state');
    assert.equal(authed.body.mode, 'ready');
    assert.equal(authed.body.authed, true);
    assert.equal(authed.body.user, user);

    // A second setup attempt is rejected and still says nothing about the existing account.
    const repeated = await request('auth/setup', 'POST', { user: 'intruder', ks: 'a'.repeat(64) }, false);
    assert.equal(repeated.status, 403);
    assertNoAccountName(repeated.text, 'auth/setup');

    // Logging out returns the caller to the anonymous side of the protocol.
    assert.equal((await api('auth/logout', 'POST')).status, 200);
    cookie = '';

    const anonymous = await api('auth/state', 'GET', undefined, false);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.authed, false);
    assert.equal(anonymous.body.user, null);
    assert.equal(anonymous.body.mode, 'ready', 'mode still reports that an account exists');
    assertNoAccountName(anonymous.text, 'auth/state');

    // An unknown or forged session cookie is anonymous too.
    const forged = await fetch(`${base}/api/auth/state`, { headers: { Cookie: `dl_sess=${'f'.repeat(64)}` } });
    const forgedText = await forged.text();
    assert.equal(JSON.parse(forgedText).authed, false);
    assert.equal(JSON.parse(forgedText).user, null);
    assertNoAccountName(forgedText, 'auth/state with an unknown session');

    // The challenge stays reachable without a session but carries only derivation material.
    const challenge = await api('auth/challenge', 'GET', undefined, false);
    assert.equal(challenge.status, 200);
    assert.equal(typeof challenge.body.nonce, 'string');
    assert.equal(challenge.body.nonce.length, 32);
    assert.equal(typeof challenge.body.salt, 'string');
    assert.equal(challenge.body.iters, 100000);
    assert.ok(!('user' in challenge.body), 'the challenge must not return the account name');
    assertNoAccountName(challenge.text, 'auth/challenge');

    // Answering the challenge from an anonymous client is still a complete login.
    const loginProof = await proof();
    const login = await api('auth/login', 'POST', { user, nonce: loginProof.nonce, proof: loginProof.proof }, false);
    assert.equal(login.status, 200);
    assert.equal(login.body.ok, true);
    assert.equal(login.body.user, user);
    assert.ok(cookie, 'a successful login must issue a session');
    const resumed = await api('auth/state');
    assert.equal(resumed.body.authed, true);
    assert.equal(resumed.body.user, user);

    // The challenge endpoint never carries the account name, session or not.
    assert.ok(!('user' in (await api('auth/challenge', 'GET')).body));

    // A wrong password is refused without confirming the account name.
    const wrong = await proof('wrong-password');
    const rejected = await request('auth/login', 'POST', { user, nonce: wrong.nonce, proof: wrong.proof }, false);
    assert.equal(rejected.status, 401);
    assertNoAccountName(rejected.text, 'auth/login failure');

    // A valid password with the wrong name fails the same way, with the very same reply.
    const wrongNameProof = await proof();
    const wrongName = await request('auth/login', 'POST', { user: 'intruder', nonce: wrongNameProof.nonce, proof: wrongNameProof.proof }, false);
    assert.equal(wrongName.status, 401);
    assert.equal(wrongName.text, rejected.text, 'a wrong name and a wrong password must be indistinguishable');
    assertNoAccountName(wrongName.text, 'auth/login wrong name');

    // A missing name is refused rather than treated as "someone else".
    const namelessProof = await proof();
    const nameless = await request('auth/login', 'POST', { nonce: namelessProof.nonce, proof: namelessProof.proof }, false);
    assert.equal(nameless.status, 401);
    assert.equal(nameless.text, rejected.text, 'omitting the name must fail like a wrong proof');
    assertNoAccountName(nameless.text, 'auth/login without a name');

    // Malformed and replayed proofs are refused as well.
    const malformed = await proof();
    const malformedResponse = await request('auth/login', 'POST', { user, nonce: malformed.nonce, proof: 'not-a-proof' }, false);
    assert.equal(malformedResponse.status, 401);
    assert.equal(malformedResponse.text, rejected.text, 'a malformed proof must fail like a wrong one');
    assertNoAccountName(malformedResponse.text, 'auth/login malformed proof');
    const replay = await proof();
    assert.equal((await api('auth/login', 'POST', { user, nonce: replay.nonce, proof: replay.proof }, false)).status, 200);
    const reused = await request('auth/login', 'POST', { user, nonce: replay.nonce, proof: replay.proof }, false);
    assert.notEqual(reused.status, 200, 'a challenge must not be replayable');
    assertNoAccountName(reused.text, 'auth/login replay');

    // Space locking keeps its two factors: a session, then a fresh proof.
    const created = await api('spaces', 'POST', { title: 'Anonymous Lock' });
    assert.equal(created.status, 201);
    const spacePath = `spaces/${created.body.slug}`;
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: true })).status, 200);
    const anonymousUnlock = await request(`${spacePath}/lock`, 'POST', { locked: false, ...(await proof()) }, false);
    assert.equal(anonymousUnlock.status, 401, 'unlocking requires a session even with a valid proof');
    assertNoAccountName(anonymousUnlock.text, 'spaces unlock without a session');
    const unlockProof = await proof();
    assert.equal((await api(`${spacePath}/lock`, 'POST', { locked: false, ...unlockProof })).status, 200);
    const replayUnlock = await request(`${spacePath}/lock`, 'POST', { locked: false, ...unlockProof });
    assert.notEqual(replayUnlock.status, 200, 'a successful proof must not be replayable');

    // Signing out takes the write permission away again, and the refusal names nobody.
    assert.equal((await api('auth/logout', 'POST')).status, 200);
    cookie = '';
    const anonymousWrite = await request(`${spacePath}/lock`, 'POST', { locked: true }, false);
    assert.equal(anonymousWrite.status, 401, 'locking still requires a session');
    assertNoAccountName(anonymousWrite.text, 'spaces lock without a session');

    // The site stays anonymous after all of that, and the account can still be reached by password.
    const finalState = await api('auth/state', 'GET', undefined, false);
    assert.equal(finalState.body.authed, false);
    assert.equal(finalState.body.user, null);
    assertNoAccountName(finalState.text, 'auth/state after logout');
    const again = await proof();
    assert.equal((await api('auth/login', 'POST', { user, nonce: again.nonce, proof: again.proof }, false)).status, 200);
    assert.equal((await api('auth/state')).body.user, user);

    /* ---- rate limiting counts both factors the same way -------------------
       A wrong name must be as "expensive" as a wrong password, so the shared failure counter has
       to fill at the same rate and the throttled reply has to be identical either way. This runs
       last because it deliberately exhausts the counter for this address. */
    assert.equal((await api('auth/logout', 'POST')).status, 200);
    cookie = '';
    const throttled: string[] = [];
    for (let i = 0; i < 8; i++) {
      const attempt = await proof(i % 2 ? 'wrong-password' : password);
      const body = i % 2
        ? { user, nonce: attempt.nonce, proof: attempt.proof }          // right name, wrong password
        : { user: 'intruder', nonce: attempt.nonce, proof: attempt.proof }; // wrong name, right password
      const response = await request('auth/login', 'POST', body, false);
      assert.equal(response.status, 401, `attempt ${i} must be refused with 401`);
      assertNoAccountName(response.text, `auth/login attempt ${i}`);
      throttled.push(response.text);
    }
    assert.equal(new Set(throttled).size, 1, 'every refused attempt must share one reply');
    // Even a fully correct attempt is now throttled, and the throttle message names nobody.
    const correct = await proof();
    const limited = await request('auth/login', 'POST', { user, nonce: correct.nonce, proof: correct.proof }, false);
    assert.equal(limited.status, 429, 'both factors share one failure budget');
    assert.match(JSON.parse(limited.text).error, /尝试过于频繁/);
    assertNoAccountName(limited.text, 'auth/login throttled');

    console.log('auth anonymous integration assertions passed');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
