import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanOutput } from '../cleanup.js';
import { createPublisher } from '../publish.js';

test('cleanOutput : supprime les vieux Shorts, garde ceux à valider', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const out = path.join(dir, 'output');
  fs.mkdirSync(out);
  const old = Date.now() - 40 * 24 * 3600 * 1000;
  for (const n of ['short-aaa-1s-auto.mp4', 'short-bbb-1s-auto.mp4', 'autre.txt']) {
    const p = path.join(out, n);
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, old / 1000, old / 1000);
  }
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ items: [{ name: 'short-bbb-1s-auto.mp4' }], done: {} }));
  const n = cleanOutput({ outputDir: out, stateFile: path.join(dir, 'queue.json'), days: 30 });
  assert.equal(n, 1);
  assert.deepEqual(fs.readdirSync(out).sort(), ['autre.txt', 'short-bbb-1s-auto.mp4']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanOutput : KEEP_DAYS=0 ne supprime rien', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  fs.writeFileSync(path.join(dir, 'short-aaa-1s-auto.mp4'), 'x');
  assert.equal(cleanOutput({ outputDir: dir, stateFile: path.join(dir, 'q.json'), days: 0 }), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.end = (b) => (r.body = b || '');
  return r;
}

test('publish : refuse sans confirmation des droits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const p = createPublisher({ baseDir: dir, outputDir: dir, port: 3000, env: { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' } });
  const res = fakeRes();
  await p.publish({ body: { name: 'short-abc-1s-auto.mp4', title: 'T' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /autorisation|droit/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish : refuse un nom de fichier invalide', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const p = createPublisher({ baseDir: dir, outputDir: dir, port: 3000, env: { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' } });
  const res = fakeRes();
  await p.publish({ body: { name: '../secret.mp4', title: 'T', rightsConfirmed: true } }, res);
  assert.equal(res.statusCode, 400);
  fs.rmSync(dir, { recursive: true, force: true });
});
