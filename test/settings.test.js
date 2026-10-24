import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveEnv } from '../env.js';
import { currentConfig, createSettings } from '../settings.js';

const KEYS = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_MODEL', 'CLAUDE_MODEL', 'TITLE_AI', 'CLAUDE_FOR_MOMENTS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
function clearEnv() { for (const k of KEYS) delete process.env[k]; }
function tmpEnv(text = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const file = path.join(dir, '.env');
  if (text) fs.writeFileSync(file, text);
  return file;
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.end = (b) => (r.body = b || '');
  return r;
}

test('saveEnv : garde commentaires et autres lignes, met à jour ou ajoute', () => {
  clearEnv();
  const file = tmpEnv('# réglages\r\nPORT=3000\r\nGEMINI_API_KEY=ancienne\r\n');
  saveEnv(file, { GEMINI_API_KEY: 'nouvelle', TITLE_AI: 'gemini' });
  const t = fs.readFileSync(file, 'utf8');
  assert.match(t, /# réglages/);
  assert.match(t, /PORT=3000/);
  assert.match(t, /GEMINI_API_KEY=nouvelle/);
  assert.match(t, /TITLE_AI=gemini/);
  assert.ok(!t.includes('ancienne'));
  assert.ok(t.includes('\r\n'), 'garde les fins de ligne Windows');
  assert.equal(process.env.GEMINI_API_KEY, 'nouvelle');
  clearEnv();
});

test('saveEnv : refuse les retours à la ligne et les noms invalides', () => {
  const file = tmpEnv();
  assert.throws(() => saveEnv(file, { GEMINI_API_KEY: 'a\nPORT=1' }));
  assert.throws(() => saveEnv(file, { 'BAD KEY': 'x' }));
  clearEnv();
});

test('currentConfig : choix automatique et repli', () => {
  clearEnv();
  assert.equal(currentConfig().provider, 'none');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-abcdefghijklmnop';
  assert.equal(currentConfig().provider, 'claude');
  process.env.GEMINI_API_KEY = 'AIzaabcdefghijklmnop';
  assert.equal(currentConfig().provider, 'gemini');
  process.env.TITLE_AI = 'claude';
  assert.equal(currentConfig().provider, 'claude');
  process.env.TITLE_AI = 'none';
  assert.equal(currentConfig().titleAI, null);
  clearEnv();
});

test('currentConfig : Claude ne trouve les moments que si on le demande', () => {
  clearEnv();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-abcdefghijklmnop';
  assert.equal(currentConfig().momentsKey, '');
  process.env.CLAUDE_FOR_MOMENTS = '1';
  assert.equal(currentConfig().momentsKey, 'sk-ant-abcdefghijklmnop');
  clearEnv();
});

test('settings : enregistre, masque les clés, rejette les formats invalides', () => {
  clearEnv();
  const file = tmpEnv();
  let changes = 0;
  const s = createSettings({ envFile: file, port: 3000, onChange: () => changes++ });
  const res = fakeRes();
  s.save({ body: { geminiKey: 'AIzaSyEXEMPLE1234567890', titleAI: 'gemini' } }, res);
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.settings.gemini.set, true);
  assert.ok(!res.body.includes('EXEMPLE1234567890'), 'la clé complète ne doit pas être renvoyée');
  assert.equal(changes, 1);

  const bad = fakeRes();
  s.save({ body: { geminiKey: 'avec espace et "guillemets"' } }, bad);
  assert.equal(bad.statusCode, 400);

  const rm = fakeRes();
  s.save({ body: { remove: ['gemini'] } }, rm);
  assert.equal(JSON.parse(rm.body).settings.gemini.set, false);
  clearEnv();
});
