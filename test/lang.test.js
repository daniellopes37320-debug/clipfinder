import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLang } from '../lang.js';
import { buildMetadata } from '../meta.js';

test('detectLang reconnaît fr / en / es', () => {
  assert.equal(detectLang("je pense que c'est une très bonne idée pour nous et pour les gens"), 'fr');
  assert.equal(detectLang("I love how they're always on the move and this is just what you need"), 'en');
  assert.equal(detectLang('no tengo nada que decir pero esto es muy bueno para los que están aquí'), 'es');
  assert.equal(detectLang('ok'), null);
});

test('titres en anglais pour une vidéo anglaise, sans ">>"', () => {
  const m = buildMetadata({
    videoTitle: 'Funny interview', channel: 'Show',
    text: ">> I love how they're always on two of the things that you just do and this is what we have",
    link: 'https://youtu.be/x',
  });
  assert.equal(m.lang, 'en');
  assert.ok(!m.titles.some((t) => t.includes('>>')));
  assert.ok(m.description.includes('Subscribe'));
  assert.ok(!m.description.includes('Abonne'));
});

import { buildAss } from '../captions.js';
test('sous-titres automatiques répétés : pas de mots en double', () => {
  const segs = [
    { start: 0, dur: 2, text: 'whoa it is also' },
    { start: 1.5, dur: 2, text: 'it is also a little loose' },
  ];
  const ass = buildAss({ segments: segs, start: 0, end: 4 });
  const txt = ass.split('\n').filter((l) => l.startsWith('Dialogue')).map((l) => l.replace(/\{[^}]*\}/g, '')).join(' ');
  assert.equal((txt.match(/also/g) || []).length, 1);
  assert.ok(txt.includes('loose'));
});

import { normalizeTranscript, fetchSegments } from '../analysis.js';
test('sous-titres : les « >> » de changement de locuteur sont retirés', () => {
  const r = normalizeTranscript([{ offset: 0, duration: 2, text: '&gt;&gt; Look, nobody is looking at her' }, { offset: 2, duration: 2, text: '>> et toi' }]);
  assert.deepEqual(r.map((x) => x.text), ['Look, nobody is looking at her', 'et toi']);
});

test('fetchSegments : vidéo française avec piste par défaut anglaise -> prend la piste française', async () => {
  const mk = (t) => Array.from({ length: 12 }, (_, i) => ({ text: t, offset: i * 3, duration: 3 }));
  const fr = mk("je pense que c'est une très bonne idée pour nous et pour les gens");
  const en = mk('I think this is the best thing that you can do for the family and it was great');
  const fetcher = async (id, cfg) => (cfg?.lang === 'fr' ? fr : cfg?.lang === 'en' ? en : en);
  const segs = await fetchSegments('dQw4w9WgXcQ', { fetcher, preferLang: 'fr' });
  assert.match(segs[0].text, /très bonne idée/);
  // sans langue connue, la piste par défaut est gardée (comportement inchangé)
  const def = await fetchSegments('dQw4w9WgXcQ', { fetcher });
  assert.match(def[0].text, /best thing/);
});

test('detectLang : un titre court suffit avec min=3', () => {
  assert.equal(detectLang('Voici pourquoi je pense que', { min: 3 }), 'fr');
  assert.equal(detectLang('Voici pourquoi je pense que'), null);
});
