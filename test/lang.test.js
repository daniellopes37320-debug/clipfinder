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
