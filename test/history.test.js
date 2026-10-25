import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCutHandlers } from '../cut.js';

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.end = (b) => (r.body = b || '');
  return r;
}

test('historique : liste les Shorts avec titre, durée et source, du plus récent au plus ancien', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const c = createCutHandlers({ baseDir: dir });
  const old = Date.now() / 1000 - 3600;
  fs.writeFileSync(path.join(c.outputDir, 'short-aaa-1s-auto.mp4'), 'x');
  fs.utimesSync(path.join(c.outputDir, 'short-aaa-1s-auto.mp4'), old, old);
  fs.writeFileSync(path.join(c.outputDir, 'short-bbb-9s-blur.mp4'), 'xx');
  fs.writeFileSync(path.join(c.outputDir, 'autre.txt'), 'ignoré');
  fs.writeFileSync(path.join(c.outputDir, 'history.json'), JSON.stringify({ 'short-bbb-9s-blur.mp4': { title: 'Mon titre', source: 'video.mp4', duration: 38 } }));
  const res = fakeRes();
  c.history({}, res);
  const { items } = JSON.parse(res.body);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'short-bbb-9s-blur.mp4');
  assert.equal(items[0].title, 'Mon titre');
  assert.equal(items[0].duration, 38);
  assert.equal(items[1].title, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('historique : fichier history.json absent ou illisible ne casse rien', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const c = createCutHandlers({ baseDir: dir });
  fs.writeFileSync(path.join(c.outputDir, 'short-aaa-1s-auto.mp4'), 'x');
  fs.writeFileSync(path.join(c.outputDir, 'history.json'), '{pas du json');
  const res = fakeRes();
  c.history({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).items.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
