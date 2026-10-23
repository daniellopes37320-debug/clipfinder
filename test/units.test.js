import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoId, fmt } from '../analysis.js';
import { parseSubtitles, buildAss } from '../captions.js';
import { findClipsSimple } from '../heuristic.js';
import { buildCropX, sanitizeSamples, FRAMINGS } from '../reframe.js';

test('extractVideoId : liens courants', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractVideoId : entrées invalides', () => {
  assert.ok(!extractVideoId('pas un lien'));
  assert.ok(!extractVideoId(''));
  assert.ok(!extractVideoId('https://example.com/watch?v=abc'));
});

test('fmt : minutes et heures', () => {
  assert.match(fmt(65), /1:05/);
});

test('parseSubtitles : SRT et VTT', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nBonjour <i>tout</i> le monde\n\n2\n00:00:04,000 --> 00:00:06,500\nSalut\n';
  const a = parseSubtitles(srt);
  assert.equal(a.length, 2);
  assert.equal(a[0].text, 'Bonjour tout le monde');
  assert.equal(a[0].start, 1);
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';
  assert.equal(parseSubtitles(vtt)[0].text, 'Hello');
});

test('buildAss : produit un fichier ASS avec dialogues', () => {
  const segments = [
    { start: 10, dur: 3, text: 'Premier sous-titre' },
    { start: 13, dur: 3, text: 'Deuxième sous-titre' },
  ];
  const ass = buildAss({ segments, start: 10, end: 20 });
  assert.match(ass, /\[Script Info\]/);
  assert.match(ass, /Dialogue:/);
});

test('findClipsSimple : propose des extraits cohérents', () => {
  const segments = [];
  for (let t = 0; t < 300; t += 5) segments.push({ start: t, dur: 5, text: t % 60 < 10 ? 'incroyable ! vraiment incroyable' : 'texte normal ici' });
  const r = findClipsSimple(segments, 300, 3, 40);
  assert.ok(Array.isArray(r.clips) && r.clips.length > 0);
  for (const c of r.clips) {
    assert.ok(c.start >= 0 && c.end > c.start && c.end <= 300);
  }
});

test('buildCropX : expression ffmpeg', () => {
  const x = buildCropX([{ t: 0, x: 100 }, { t: 2, x: 300 }]);
  assert.equal(typeof x, 'string');
  assert.ok(x.length > 0);
});

test('sanitizeSamples : rejette les données absurdes', () => {
  assert.ok(!sanitizeSamples(null) || sanitizeSamples(null).length === 0);
  assert.ok(FRAMINGS.includes('face'));
});
