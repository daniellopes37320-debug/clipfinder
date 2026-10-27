// Cas critiques : liens invalides, envois trop gros ou invalides, erreurs des API externes, timecodes, ffmpeg absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { extractVideoId, fetchSegments, analyzeSegments } from '../analysis.js';
import { createPublisher } from '../publish.js';
import { ffmpegAvailable, run } from '../reframe.js';

const hasFfmpeg = await ffmpegAvailable();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-rb-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.end = (b) => (r.body = b || '');
  return r;
}

async function withFetch(fn, body) {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

// ---------- lien YouTube invalide ----------
test('extractVideoId : refuse les liens et identifiants invalides', () => {
  for (const bad of ['', null, undefined, 'bonjour', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://evilyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=court', 'https://www.youtube.com/watch?v=../../etc/passwd', 'https://youtu.be/abc', 'https://www.youtube.com/watch']) {
    assert.equal(extractVideoId(bad), null, String(bad));
  }
});

test('extractVideoId : accepte les formats YouTube usuels', () => {
  const id = 'dQw4w9WgXcQ';
  for (const ok of [id, `https://youtu.be/${id}?si=x`, `https://www.youtube.com/watch?v=${id}&t=5`, `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`, `https://youtube.com/embed/${id}`]) {
    assert.equal(extractVideoId(ok), id, ok);
  }
});

// ---------- transcription ----------
test('fetchSegments : erreur de la bibliothèque -> NO_TRANSCRIPT', async () => {
  await assert.rejects(fetchSegments('dQw4w9WgXcQ', { fetcher: async () => { throw new Error('boom'); } }), { code: 'NO_TRANSCRIPT' });
});

test('fetchSegments : réponse qui ne vient jamais -> NO_TRANSCRIPT (délai)', async () => {
  const t0 = Date.now();
  await assert.rejects(fetchSegments('dQw4w9WgXcQ', { fetcher: () => new Promise(() => {}), timeoutMs: 60 }), { code: 'NO_TRANSCRIPT' });
  assert.ok(Date.now() - t0 < 2000);
});

test('fetchSegments : transcription vide ou sans texte -> NO_TRANSCRIPT', async () => {
  await assert.rejects(fetchSegments('dQw4w9WgXcQ', { fetcher: async () => [] }), { code: 'NO_TRANSCRIPT' });
  await assert.rejects(fetchSegments('dQw4w9WgXcQ', { fetcher: async () => [{ text: '  ', offset: 0, duration: 2 }, { text: '', offset: 2, duration: 2 }] }), { code: 'NO_TRANSCRIPT' });
});

test('fetchSegments : piste par défaut dans une autre langue -> prend la langue parlée', async () => {
  const arabic = Array.from({ length: 12 }, (_, i) => ({ text: 'مرحبا بكم في هذا الفيديو الجميل', offset: i * 3, duration: 3 }));
  const english = Array.from({ length: 12 }, (_, i) => ({ text: "I think this is the best thing that you can do for the family and it was great", offset: i * 3, duration: 3 }));
  const calls = [];
  const fetcher = async (id, cfg) => {
    calls.push(cfg?.lang || 'défaut');
    if (!cfg) return arabic;
    if (cfg.lang === 'en') return english;
    throw new Error('indisponible');
  };
  const segs = await fetchSegments('dQw4w9WgXcQ', { fetcher });
  assert.match(segs[0].text, /best thing/);
  assert.deepEqual(calls, ['défaut', 'en']);
});

// ---------- erreurs de l'API Claude ----------
const SEGS = Array.from({ length: 40 }, (_, i) => ({ start: i * 5, dur: 5, text: `phrase numéro ${i} avec un contenu assez long pour être analysé correctement ici` }));

test('analyzeSegments : erreur HTTP de Claude -> analyse simple + avertissement', async () => {
  const r = await withFetch(async () => new Response('{"error":"overloaded"}', { status: 529 }), () => analyzeSegments({ segments: SEGS, videoId: 'dQw4w9WgXcQ', apiKey: 'sk-test', model: 'm' }));
  assert.equal(r.mode, 'simple');
  assert.match(r.notice, /Analyse IA indisponible/);
  assert.ok(r.clips.length > 0);
});

test('analyzeSegments : réponse Claude sans liste de clips -> repli sur l\'analyse simple', async () => {
  const body = JSON.stringify({ content: [{ type: 'text', text: '{"video_summary":"x","clips":"pas une liste"}' }] });
  const r = await withFetch(async () => new Response(body, { status: 200 }), () => analyzeSegments({ segments: SEGS, videoId: 'dQw4w9WgXcQ', apiKey: 'sk-test', model: 'm' }));
  assert.equal(r.mode, 'simple');
  assert.ok(r.clips.length > 0);
});

test('analyzeSegments : réponse Claude en JSON invalide -> repli', async () => {
  const body = JSON.stringify({ content: [{ type: 'text', text: 'désolé, {pas du json' }] });
  const r = await withFetch(async () => new Response(body, { status: 200 }), () => analyzeSegments({ segments: SEGS, videoId: 'dQw4w9WgXcQ', apiKey: 'sk-test', model: 'm' }));
  assert.equal(r.mode, 'simple');
});

test('analyzeSegments : sans aucun texte -> erreur claire, pas de plantage', async () => {
  await assert.rejects(analyzeSegments({ segments: [], videoId: 'dQw4w9WgXcQ' }), /Aucun texte/);
});

// ---------- publication YouTube / Google ----------
function publisher(dir) {
  fs.writeFileSync(path.join(dir, 'short-abc-1s-auto.mp4'), 'video');
  fs.writeFileSync(path.join(dir, 'youtube-token.json'), JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3600_000 }));
  return createPublisher({ baseDir: dir, outputDir: dir, port: 3000, env: { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' } });
}
const pub = { name: 'short-abc-1s-auto.mp4', title: 'Titre', rightsConfirmed: true };

test('publish : quota YouTube dépassé -> 429 avec message en français', async () => {
  const dir = tmp();
  const res = fakeRes();
  const body = JSON.stringify({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } });
  await withFetch(async () => new Response(body, { status: 403 }), () => publisher(dir).publish({ body: pub }, res));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /quota/i);
  rm(dir);
});

test('publish : autorisation Google expirée (invalid_grant) -> 401 et jeton supprimé', async () => {
  const dir = tmp();
  const p = publisher(dir);
  fs.writeFileSync(path.join(dir, 'youtube-token.json'), JSON.stringify({ refresh_token: 'r', access_token: 'old', expires_at: 1 }));
  const res = fakeRes();
  await withFetch(async () => new Response('{"error":"invalid_grant"}', { status: 400 }), () => p.publish({ body: pub }, res));
  assert.equal(res.statusCode, 401);
  assert.ok(!fs.existsSync(path.join(dir, 'youtube-token.json')));
  rm(dir);
});

test('publish : Google injoignable (délai) -> message clair, pas de plantage', async () => {
  const dir = tmp();
  const res = fakeRes();
  await withFetch(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, () => publisher(dir).publish({ body: pub }, res));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /ne répond pas/);
  rm(dir);
});

test('publish : « < » et « > » retirés du titre et de la description (refusés par YouTube)', async () => {
  const dir = tmp();
  let sent = null;
  await withFetch(async (url, opts) => { sent = JSON.parse(opts.body); return new Response('{}', { status: 400 }); }, () =>
    publisher(dir).publish({ body: { ...pub, title: '>> Titre <b>', description: '>> « phrase » <script>' } }, fakeRes()));
  assert.ok(sent);
  assert.ok(!/[<>]/.test(sent.snippet.title + sent.snippet.description));
  rm(dir);
});

// ---------- envois (upload) ----------
async function loadCut(maxGb) {
  process.env.MAX_UPLOAD_GB = String(maxGb);
  return import('../cut.js?max=' + maxGb);
}

function serve(handlers) {
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    if (req.url.startsWith('/api/upload')) return handlers.upload(req, res);
    for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : {};
    if (req.url === '/api/cut') return handlers.cut(req, res);
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

const post = (srv, url, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request({ port: srv.address().port, host: '127.0.0.1', path: url, method: 'POST', headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : {} }));
    });
    r.on('error', reject);
    r.end(body);
  });

test('upload : fichier trop gros (Content-Length annoncé) -> 413 et rien sur le disque', async () => {
  const { createCutHandlers } = await loadCut(0.000002); // ≈ 2 Ko
  const dir = tmp();
  const c = createCutHandlers({ baseDir: dir });
  const srv = await serve(c);
  const r = await post(srv, '/api/upload?name=a.mp4', Buffer.alloc(5000));
  assert.equal(r.status, 413);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
  srv.close();
  rm(dir);
});

test('upload : trop gros sans Content-Length (envoi en morceaux) -> 413, fichier partiel supprimé', async () => {
  const { createCutHandlers } = await loadCut(0.000002);
  const dir = tmp();
  const srv = await serve(createCutHandlers({ baseDir: dir }));
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ port: srv.address().port, host: '127.0.0.1', path: '/api/upload?name=a.mp4', method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    });
    req.on('error', reject);
    for (let i = 0; i < 5; i++) req.write(Buffer.alloc(1000));
    req.end();
  });
  assert.equal(r.status, 413);
  await new Promise((r2) => setTimeout(r2, 100));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
  srv.close();
  rm(dir);
});

test('upload : extension non vidéo refusée (400)', async () => {
  const { createCutHandlers } = await loadCut(4);
  const dir = tmp();
  const srv = await serve(createCutHandlers({ baseDir: dir }));
  for (const name of ['virus.exe', 'x.mp4.sh', 'noext']) {
    const r = await post(srv, '/api/upload?name=' + encodeURIComponent(name), Buffer.from('abc'));
    assert.equal(r.status, 400, name);
  }
  srv.close();
  rm(dir);
});

test('upload : fichier .mp4 qui n\'est pas une vidéo -> refusé et supprimé', { skip: hasFfmpeg ? false : 'ffmpeg absent' }, async () => {
  const { createCutHandlers } = await loadCut(4);
  const dir = tmp();
  const srv = await serve(createCutHandlers({ baseDir: dir }));
  const r = await post(srv, '/api/upload?name=faux.mp4', Buffer.from('ceci est du texte, pas une vidéo'));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /pas une vidéo/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
  srv.close();
  rm(dir);
});

// ---------- timecodes ----------
test('cut : timecodes et paramètres invalides -> 400', async () => {
  const { createCutHandlers } = await loadCut(4);
  const dir = tmp();
  const srv = await serve(createCutHandlers({ baseDir: dir }));
  const id = 'abcdef01';
  const bad = [
    { start: -5, end: 10 }, { start: 10, end: 10 }, { start: 20, end: 10 }, { start: 'abc', end: 10 },
    { start: 0, end: 500 }, { start: 0, end: null }, { start: 0, end: 1e12 }, {},
  ];
  for (const t of bad) {
    const r = await post(srv, '/api/cut', JSON.stringify({ uploadId: id, ...t }), { 'content-type': 'application/json' });
    assert.equal(r.status, 400, JSON.stringify(t));
    assert.match(r.json.error, /Timecodes/);
  }
  const r2 = await post(srv, '/api/cut', JSON.stringify({ uploadId: id, start: 0, end: 10, framing: 'zoom-fou' }), { 'content-type': 'application/json' });
  assert.equal(r2.status, 400);
  const r3 = await post(srv, '/api/cut', JSON.stringify({ uploadId: '../../x', start: 0, end: 10 }), { 'content-type': 'application/json' });
  assert.equal(r3.status, 400);
  const r4 = await post(srv, '/api/cut', JSON.stringify({ uploadId: id, start: 0, end: 10 }), { 'content-type': 'application/json' });
  assert.equal(r4.status, 404); // identifiant valide mais fichier absent
  srv.close();
  rm(dir);
});

test('cut : début collé à la fin de la vidéo / hors vidéo -> 400 (vraie vidéo de 3 s)', { skip: hasFfmpeg ? false : 'ffmpeg absent' }, async () => {
  const { createCutHandlers } = await loadCut(4);
  const dir = tmp();
  const vid = path.join(dir, 'v.mp4');
  const g = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3', '-pix_fmt', 'yuv420p', vid]);
  assert.equal(g.status, 0);
  const srv = await serve(createCutHandlers({ baseDir: dir }));
  const up = await post(srv, '/api/upload?name=v.mp4', fs.readFileSync(vid));
  assert.equal(up.status, 200);
  const h = { 'content-type': 'application/json' };
  const late = await post(srv, '/api/cut', JSON.stringify({ uploadId: up.json.uploadId, start: 2.9, end: 20, framing: 'center' }), h);
  assert.equal(late.status, 400);
  assert.match(late.json.error, /trop court/);
  const after = await post(srv, '/api/cut', JSON.stringify({ uploadId: up.json.uploadId, start: 50, end: 60, framing: 'center' }), h);
  assert.equal(after.status, 400);
  assert.match(after.json.error, /dure/);
  srv.close();
  rm(dir);
});

// ---------- ffmpeg absent / bloqué ----------
test('ffmpeg absent : run() signale FFMPEG_MISSING', async () => {
  await assert.rejects(run('ffmpeg-introuvable-xyz', ['-version']), { code: 'FFMPEG_MISSING' });
});

test('ffmpeg absent : probe() sans ffmpeg dans le PATH -> FFMPEG_MISSING, et /api/status le sait', () => {
  const code = `import { probe, ffmpegAvailable } from ${JSON.stringify(path.resolve('reframe.js'))};
    const ok = await ffmpegAvailable();
    let c = null; try { await probe('x.mp4'); } catch (e) { c = e.code; }
    console.log(JSON.stringify({ ok, c }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PATH: '', FFMPEG_PATH: 'ffmpeg-introuvable', FFPROBE_PATH: 'ffprobe-introuvable' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout), { ok: false, c: 'FFMPEG_MISSING' });
});

test('ffmpeg bloqué : run() arrête le processus après le délai', async () => {
  const t0 = Date.now();
  await assert.rejects(run(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 }), /trop long/);
  assert.ok(Date.now() - t0 < 5000);
});

test('ffmpeg qui échoue : le fichier de sortie partiel est supprimé', { skip: hasFfmpeg ? false : 'ffmpeg absent' }, async () => {
  const { makeShort } = await import('../reframe.js');
  const dir = tmp();
  const input = path.join(dir, 'v.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', input]);
  const out = path.join(dir, 'short-x.mp4');
  fs.writeFileSync(out, 'reste d\'un échec');
  await assert.rejects(makeShort({ input, start: 0, end: 2, framing: 'center', outPath: out, info: { width: 320, height: 240, duration: 2 }, assText: 'pas un fichier ASS valide', workDir: dir }));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(out) || fs.statSync(out).size > 100, 'le fichier partiel ne doit pas rester');
  rm(dir);
});
