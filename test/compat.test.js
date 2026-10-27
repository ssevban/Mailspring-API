// End-to-end compatibility tests against the request shapes the current Mailspring
// client (Foundry376/Mailspring) and sync engine (Foundry376/Mailspring-Sync) send.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'tester@example.com';
const PASSWORD = 'correct horse battery';
const ACCOUNT_ID = 'A1B2C3D4';

let workdir, server, serverLog = '', token, identity;

function waitForServer() {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const tick = async () => {
            try {
                await fetch(BASE + '/robots.txt');
                resolve();
            } catch(e) {
                if(Date.now() > deadline) reject(new Error('server did not start:\n' + serverLog));
                else setTimeout(tick, 100);
            }
        };
        tick();
    });
}

before(async () => {
    // Run a copy of the server in a scratch dir so ./data is isolated.
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailspring-api-test-'));
    for(const f of ['index.js', 'manage.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(workdir, f));
    fs.cpSync(path.join(ROOT, 'static'), path.join(workdir, 'static'), {recursive: true});
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(workdir, 'node_modules'));

    execFileSync('node', ['manage.js', 'user', 'add', '--fullName', 'Test User', '--email', EMAIL, '--password', PASSWORD], {cwd: workdir});

    server = spawn('node', ['index.js'], {cwd: workdir, env: {...process.env, API_PORT: String(PORT), LOG_LEVEL: 'debug'}});
    server.stdout.on('data', d => serverLog += d);
    server.stderr.on('data', d => serverLog += d);
    await waitForServer();
});

after(() => {
    server.kill();
    fs.rmSync(workdir, {recursive: true, force: true});
});

// Same header the client (mailspring-api-request.ts) and sync engine (NetworkRequestUtils.cpp) build.
const auth = () => ({Authorization: 'Basic ' + Buffer.from(token + ':').toString('base64')});

function api(p, {method = 'GET', body} = {}) {
    return fetch(BASE + p, {
        method,
        headers: {...auth(), 'Content-Type': 'application/json', Accept: 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

// Mirrors encodeOpenTrackingToken() in the client's open-tracking-composer-extension.ts.
const encodeOpenTrackingToken = params =>
    Buffer.from(JSON.stringify(params)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Opens /deltas/<aid>/streaming like MetadataWorker.cpp and collects newline-delimited events.
async function openDeltaStream(cursor) {
    const controller = new AbortController();
    const resp = await fetch(`${BASE}/deltas/${ACCOUNT_ID}/streaming?p=linux&ih=imap.example.com&cursor=${cursor}`, {headers: auth(), signal: controller.signal});
    assert.equal(resp.status, 200);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = '';
    (async () => {
        try {
            for(;;) {
                const {value, done} = await reader.read();
                if(done) break;
                buffer += decoder.decode(value, {stream: true});
                let i;
                while((i = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, i);
                    buffer = buffer.slice(i + 1);
                    if(line.length > 1) events.push(JSON.parse(line));
                }
            }
        } catch(e) { /* aborted */ }
    })();
    return {
        events,
        close: () => controller.abort(),
        async next(predicate, timeout = 3000) {
            const deadline = Date.now() + timeout;
            while(Date.now() < deadline) {
                const found = events.find(predicate);
                if(found) return found;
                await new Promise(r => setTimeout(r, 25));
            }
            throw new Error('no matching delta event; got ' + JSON.stringify(events));
        }
    };
}

async function head() {
    const resp = await api(`/deltas/${ACCOUNT_ID}/head`);
    assert.equal(resp.status, 200);
    return (await resp.json()).cursor;
}

async function metadataFor(objectId, pluginId) {
    const all = await (await api(`/metadata/${ACCOUNT_ID}?limit=500&offset=0`)).json();
    return all.find(m => m.object_id === objectId && m.plugin_id === pluginId);
}

// Payload shape from TaskProcessor::performRemoteSyncbackMetadata.
function postMetadata(objectId, pluginId, value, version = 1, objectType = 'message') {
    return api(`/metadata/${ACCOUNT_ID}/${objectId}/${pluginId}`, {method: 'POST', body: {objectType, version, value, headerMessageId: value.uid}});
}

test('login + /api/me + onboarding identity', async () => {
    const bad = await fetch(BASE + '/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({emailAddress: EMAIL, password: 'nope'})});
    assert.equal(bad.status, 401);

    const resp = await fetch(BASE + '/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({emailAddress: EMAIL, password: PASSWORD})});
    assert.equal(resp.status, 200);
    const body = await resp.json();
    token = body.token;
    assert.ok(token);
    const cookie = resp.headers.get('set-cookie');
    assert.match(cookie, /session=/);
    assert.match(cookie, /HttpOnly/i);

    // onboarding page the client's AuthenticatePage webview reads #identity-result from
    const onboarding = await (await fetch(BASE + '/onboarding', {headers: {Cookie: cookie.split(';')[0]}})).text();
    const encoded = onboarding.match(/<div id="identity-result"[^>]*>([^<]+)<\/div>/)[1];
    identity = JSON.parse(Buffer.from(encoded, 'base64').toString());
    assert.equal(identity.token, token);
    assert.equal(identity.emailAddress, EMAIL);

    const me = await api('/api/me');
    assert.equal(me.status, 200);
    const json = await me.json();
    // fields IIdentity in identity-store.ts reads
    assert.equal(json.id, identity.id);
    assert.equal(json.emailAddress, EMAIL);
    assert.equal(typeof json.featureUsage, 'object');
    assert.notEqual(json.stripePlanEffective, 'Basic');
    assert.equal(json.passwordHash, undefined);

    const noAuth = await fetch(BASE + '/api/me');
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(BASE + '/api/me', {headers: {Authorization: 'Basic ' + Buffer.from('bogus:').toString('base64')}});
    assert.equal(badAuth.status, 401);
});

test('metadata POST keeps the client version (MailModel::upsertMetadata ignores <= local v)', async () => {
    const resp = await postMetadata('THREAD1', 'snooze', {expiration: 1}, 3, 'thread');
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).v, 3);
    const update = await postMetadata('THREAD1', 'snooze', {expiration: 2}, 5, 'thread');
    assert.equal((await update.json()).v, 5);
    const stale = await postMetadata('THREAD1', 'snooze', {expiration: 3}, 4, 'thread');
    assert.equal(stale.status, 409);
    assert.equal((await metadataFor('THREAD1', 'snooze')).v, 5);
});

test('open tracking: new /o/<token>.png and legacy /open/ both count and emit a delta', async () => {
    const hmid = 'OPEN-1111@getmailspring.com';
    const created = await postMetadata('MSG1', 'open-tracking', {open_count: 0, open_data: [], uid: hmid});
    assert.equal(created.status, 200);

    const stream = await openDeltaStream(await head());
    try {
        const pixel = await fetch(`${BASE}/o/${encodeOpenTrackingToken({messageId: hmid, accountId: ACCOUNT_ID, recipient: 'bob@example.com'})}.png`);
        assert.equal(pixel.status, 200);
        assert.equal(pixel.headers.get('content-type'), 'image/png');
        const ev1 = await stream.next(e => e.event === 'modify' && e.attributes.value.open_count === 1);
        assert.equal(ev1.object, 'metadata');
        assert.equal(ev1.attributes.plugin_id, 'open-tracking');
        assert.equal(ev1.attributes.object_id, 'MSG1');
        assert.equal(ev1.attributes.value.open_data[0].recipient, 'bob@example.com');
        assert.equal(typeof ev1.cursor, 'string');

        // shared_body sends (Microsoft Graph accounts) carry no recipient
        await fetch(`${BASE}/o/${encodeOpenTrackingToken({messageId: hmid, accountId: ACCOUNT_ID})}.png`);
        await stream.next(e => e.attributes.value.open_count === 2);

        const legacy = await fetch(`${BASE}/open/${encodeURIComponent(hmid)}?me=${ACCOUNT_ID}&recipient=${encodeURIComponent(Buffer.from('carol@example.com').toString('base64'))}`);
        assert.equal(legacy.status, 200);
        assert.match(legacy.headers.get('content-type'), /^image\//);
        const ev3 = await stream.next(e => e.attributes.value.open_count === 3);
        assert.equal(ev3.attributes.value.open_data[2].recipient, 'carol@example.com');
    } finally {
        stream.close();
    }
    const stored = await metadataFor('MSG1', 'open-tracking');
    assert.equal(stored.value.open_count, 3);
    assert.equal(stored.v, 4);
});

test('link tracking: redirect + click_count, recipient is standard base64 + URI encoded', async () => {
    const hmid = 'LINK-2222@getmailspring.com';
    const url = 'https://example.com/path?a=1&b=two#frag';
    const created = await postMetadata('MSG2', 'link-tracking', {
        uid: hmid,
        links: [{url, click_count: 0, click_data: [], redirect_url: `x/link/${hmid}/0?redirect=${encodeURIComponent(url)}`}]
    });
    assert.equal(created.status, 200);

    const stream = await openDeltaStream(await head());
    try {
        // emails whose base64 contains '+' and '=' (would break if not URI-decoded)
        for(const [i, email] of ['jo~hn@ex.com', '??~~@x.com'].entries()) {
            const recipient = encodeURIComponent(Buffer.from(email).toString('base64'));
            const resp = await fetch(`${BASE}/link/${hmid}/0?redirect=${encodeURIComponent(url)}&recipient=${recipient}`, {redirect: 'manual'});
            assert.equal(resp.status, 302);
            assert.equal(resp.headers.get('location'), url);
            const ev = await stream.next(e => e.attributes.plugin_id === 'link-tracking' && e.attributes.value.links[0].click_count === i + 1);
            assert.equal(ev.attributes.value.links[0].click_data[i].recipient, email);
        }

        // shared_body (no recipient param) still counts
        const shared = await fetch(`${BASE}/link/${hmid}/0?redirect=${encodeURIComponent(url)}`, {redirect: 'manual'});
        assert.equal(shared.status, 302);
        await stream.next(e => e.attributes.plugin_id === 'link-tracking' && e.attributes.value.links[0].click_count === 3);
    } finally {
        stream.close();
    }
});

test('link tracking: no open redirect', async () => {
    const hmid = 'LINK-2222@getmailspring.com';
    const before = (await metadataFor('MSG2', 'link-tracking')).v;

    // redirect param that doesn't match the URL stored for that link
    const evil = await fetch(`${BASE}/link/${hmid}/0?redirect=${encodeURIComponent('https://evil.example/')}`, {redirect: 'manual'});
    assert.notEqual(evil.status, 302);
    assert.equal(evil.headers.get('location'), null);
    const html = await evil.text();
    assert.ok(!html.includes('<script'));

    // unknown message: not a redirect either
    const unknown = await fetch(`${BASE}/link/nope@x/0?redirect=${encodeURIComponent('https://evil.example/')}`, {redirect: 'manual'});
    assert.notEqual(unknown.status, 302);

    // dangerous scheme is never linked or redirected to
    const js = await fetch(`${BASE}/link/nope@x/0?redirect=${encodeURIComponent('javascript:alert(1)')}`, {redirect: 'manual'});
    assert.notEqual(js.status, 302);
    assert.ok(!(await js.text()).includes('javascript:'));

    assert.equal((await metadataFor('MSG2', 'link-tracking')).v, before);
});

test('malformed tracking input: image returned, no crash, no DB write', async () => {
    const cursor = await head();
    const bad = [
        '/o/AAAA.png',                                                     // base64 of garbage bytes
        '/o/' + Buffer.from('not json').toString('base64url') + '.png',
        '/o/' + encodeOpenTrackingToken({messageId: {$gt: ''}, accountId: ACCOUNT_ID}) + '.png',
        '/o/' + encodeOpenTrackingToken({messageId: 'OPEN-1111@getmailspring.com', accountId: ['x']}) + '.png',
        '/o/' + encodeOpenTrackingToken(null) + '.png',
        '/o/' + encodeOpenTrackingToken({messageId: 'unknown@x', accountId: ACCOUNT_ID}) + '.png',
        '/o/' + encodeOpenTrackingToken({messageId: "' OR 1=1 --", accountId: "' OR 1=1 --"}) + '.png',
        '/open/OPEN-1111@getmailspring.com',                                // legacy without ?me=
        '/open/OPEN-1111@getmailspring.com?me[a]=1&recipient=%%%'
    ];
    for(const p of bad) {
        const resp = await fetch(BASE + p);
        assert.equal(resp.status, 200, p);
        assert.match(resp.headers.get('content-type'), /^image\//, p);
        assert.ok((await resp.arrayBuffer()).byteLength > 0, p);
    }

    const badLinks = [
        '/link/LINK-2222@getmailspring.com/__proto__?redirect=https%3A%2F%2Fexample.com',
        '/link/LINK-2222@getmailspring.com/constructor?redirect=https%3A%2F%2Fexample.com',
        '/link/LINK-2222@getmailspring.com/99?redirect=https%3A%2F%2Fexample.com',
        '/link/LINK-2222@getmailspring.com/0?redirect=https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1%26b%3Dtwo%23frag&recipient[x]=1',
        '/link/LINK-2222@getmailspring.com/0',
        '/link/LINK-2222@getmailspring.com/0?redirect=%E0%A4%A'
    ];
    for(const p of badLinks) {
        const resp = await fetch(BASE + p, {redirect: 'manual'});
        assert.ok(resp.status < 500, p + ' -> ' + resp.status);
    }
    // nothing but link-tracking deltas (from the one well-formed click above) since `cursor`
    const stream = await openDeltaStream(cursor);
    await new Promise(r => setTimeout(r, 300));
    stream.close();
    assert.deepEqual(stream.events.filter(e => e.attributes.plugin_id !== 'link-tracking'), []);
    assert.equal((await metadataFor('MSG1', 'open-tracking')).value.open_count, 3);

    // server is still alive
    assert.equal((await api('/api/me')).status, 200);
    assert.equal(server.exitCode, null);
});

test('shared thread page escapes </script> in thread data', async () => {
    const form = new FormData();
    form.set('filename', 'thread-key-1');
    form.set('file', new Blob([JSON.stringify({thread: {subject: 'x'}, sharedBy: {}, fileURLs: {}, messages: [{body: '</script><script>alert(1)</script>'}]})], {type: 'text/plain'}), 'thread-key-1');
    const resp = await fetch(BASE + '/api/save-public-asset', {method: 'POST', headers: auth(), body: form});
    assert.equal(resp.status, 200);
    const page = await (await fetch(`${BASE}/thread/${identity.id}/thread-key-1`)).text();
    assert.ok(!page.includes('</script><script>alert(1)'));
});
