import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceClips, askGemini } from '../titles.js';

const base = () => [
  { start: 10, end: 50, title: 'Ancien titre', titles: ['Ancien titre'], description: 'ancienne description', tags: ['Gaming'], link: 'https://youtu.be/dQw4w9WgXcQ?t=10' },
  { start: 60, end: 100, title: 'Autre', titles: ['Autre'], description: 'd2', tags: [], link: 'https://youtu.be/dQw4w9WgXcQ?t=60' },
];
const segments = [{ start: 12, dur: 3, text: 'on vient de gagner la partie' }, { start: 65, dur: 3, text: 'regarde ce clutch' }];

test('enhanceClips : sans clé, rien ne change', async () => {
  const c = base();
  const r = await enhanceClips(c, { segments, ai: null });
  assert.deepEqual(r.clips, c);
  assert.equal(r.notice, '');
});

test('enhanceClips : applique titres, description et hashtags', async () => {
  let seen;
  const ask = async (args) => {
    seen = args;
    return [
      { id: 0, titles: ['Ils gagnent au dernier tir 😱', 'La victoire la plus serrée'], description: 'Une fin de partie incroyable.', hashtags: ['#Fortnite', 'gaming fr', 'Shorts', 'Clutch'] },
      { id: 1, titles: ['Ce clutch est fou'], description: '', hashtags: [] },
    ];
  };
  const r = await enhanceClips(base(), { segments, videoTitle: 'Ma vidéo', channel: 'Ma chaîne', link: 'x', ai: { apiKey: 'k', model: 'm' }, ask });
  assert.match(seen.clips[0].text, /gagner la partie/);
  assert.equal(r.clips[0].title, 'Ils gagnent au dernier tir 😱');
  assert.deepEqual(r.clips[0].tags, ['Fortnite', 'gamingfr', 'Clutch']);
  assert.match(r.clips[0].description, /Une fin de partie incroyable\./);
  assert.match(r.clips[0].description, /Vidéo complète : https:\/\/youtu\.be\/dQw4w9WgXcQ\?t=10/);
  assert.match(r.clips[0].description, /#Shorts #Fortnite #gamingfr #Clutch/);
  assert.equal(r.clips[1].title, 'Ce clutch est fou');
});

test('enhanceClips : échec de l\'IA -> titres simples conservés + message', async () => {
  const c = base();
  const r = await enhanceClips(c, { segments, ai: { apiKey: 'k' }, ask: async () => { throw new Error('Gemini 429 (quota gratuit atteint)'); } });
  assert.equal(r.clips[0].title, 'Ancien titre');
  assert.match(r.notice, /Titres IA indisponibles/);
});

test('enhanceClips : réponse incomplète -> garde l\'ancien pour les extraits manquants', async () => {
  const r = await enhanceClips(base(), { segments, ai: { apiKey: 'k' }, ask: async () => [{ id: 0, titles: ['Un très bon titre'], description: 'd', hashtags: [] }] });
  assert.equal(r.clips[0].title, 'Un très bon titre');
  assert.equal(r.clips[1].title, 'Autre');
});

test('askGemini : lit la réponse JSON et envoie la clé en en-tête', async () => {
  const realFetch = globalThis.fetch;
  let req;
  globalThis.fetch = async (url, opts) => {
    req = { url, opts };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"clips":[{"id":0,"titles":["Titre test ok"],"description":"d","hashtags":["a"]}]}' }] } }] }) };
  };
  try {
    const out = await askGemini({ apiKey: 'SECRET', model: 'gemini-test', videoTitle: 'V', clips: [{ start: 0, end: 30, text: 'bonjour' }] });
    assert.equal(out[0].titles[0], 'Titre test ok');
    assert.ok(!req.url.includes('SECRET'), 'la clé ne doit pas être dans l\'URL');
    assert.equal(req.opts.headers['x-goog-api-key'], 'SECRET');
    assert.match(req.url, /models\/gemini-test:generateContent/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('askGemini : erreur 404 -> message avec GEMINI_MODEL', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  try {
    await assert.rejects(() => askGemini({ apiKey: 'k', clips: [] }), /GEMINI_MODEL/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
