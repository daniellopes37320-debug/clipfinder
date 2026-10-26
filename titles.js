// Titres, descriptions et hashtags rédigés par une IA gratuite (Google Gemini), facultatif.
// Une seule requête par analyse (tous les extraits ensemble) pour rester dans les limites gratuites.
// En cas d'échec (clé absente, quota, réseau, réponse illisible), on garde les titres « règles » déjà calculés.

import { detectLang, LANG_NAMES, STR } from './lang.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const TIMEOUT_MS = 30_000;
// Si le modèle choisi n'existe pas (404), on essaie ceux-ci à la suite.
const GEMINI_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

const SYSTEM = `Tu es un expert des YouTube Shorts francophones : tu écris des titres qui donnent envie de cliquer.
Règles strictes :
- Chaque titre fait 70 caractères maximum, dans la langue de l'extrait.
- Un titre est une VRAIE accroche rédigée par toi, qui résume le sujet ou l'enjeu de l'extrait. Ne recopie JAMAIS une phrase prononcée, ni le début du texte, ni de « ... ».
- Il crée de la curiosité, de l'urgence ou une émotion (question, chiffre, promesse concrète, "tu ne devineras jamais", etc.), avec 0 à 2 emojis maximum.
- Il reste VRAI : il ne promet rien que l'extrait ne montre pas, n'invente aucun fait, aucun nom, aucun chiffre absents du texte fourni. Pas de MAJUSCULES sur tout le titre.
- Si le texte d'un extrait est vide ou trop pauvre, base-toi uniquement sur le titre de la vidéo d'origine et reste général.
- 5 titres différents par extrait, du plus accrocheur au plus sobre.
- La description : 2 ou 3 phrases courtes et naturelles qui résument l'extrait et donnent envie de voir la suite, sans le répéter mot pour mot dans le titre. Pas de lien, pas de hashtags dedans.
- 6 à 8 hashtags pertinents (sans le symbole #, sans espaces), du plus précis au plus général, sans #Shorts.
Réponds uniquement en JSON : {"clips":[{"id":0,"titles":["..."],"description":"...","hashtags":["..."]}]}`;

const clean = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const cutTo = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');
const tagOf = (s) => clean(s).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 30);

function userPrompt({ videoTitle, channel, clips }) {
  // Langue de la vidéo : détectée sur le texte parlé, sinon sur le titre d'origine.
  const lang = detectLang(clips.map((c) => c.text).join(' ')) || detectLang(videoTitle);
  const rule = lang
    ? `LANGUE OBLIGATOIRE pour tous les titres, descriptions et hashtags : ${LANG_NAMES[lang]} (la langue de la vidéo), même si ces consignes sont en français.\n\n`
    : 'Écris les titres, descriptions et hashtags dans la langue parlée dans la vidéo (pas forcément le français).\n\n';
  return (
    rule +
    `Vidéo d'origine : « ${clean(videoTitle) || 'inconnue'} »${channel ? ` (chaîne : ${clean(channel)})` : ''}\n\n` +
    'Extraits :\n' +
    clips.map((c, i) => `#${i} (${Math.round(c.start)}s → ${Math.round(c.end)}s) texte : ${c.text ? '« ' + cutTo(clean(c.text), 700) + ' »' : '(aucun texte)'}`).join('\n')
  );
}

function parseClips(text, who) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error(`Réponse ${who} inattendue.`);
  let json;
  try {
    json = JSON.parse(text.slice(a, b + 1));
  } catch {
    throw new Error(`Réponse ${who} illisible (JSON invalide).`);
  }
  return Array.isArray(json.clips) ? json.clips : [];
}

async function geminiOnce({ apiKey, model, videoTitle, channel, clips }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt({ videoTitle, channel, clips }) }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 8000, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const hint = res.status === 404 ? ' (modèle introuvable : change GEMINI_MODEL dans .env)' : res.status === 429 ? ' (quota gratuit atteint)' : '';
    const err = new Error(`Gemini ${res.status}${hint} : ${body.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini n'a rien répondu (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'raison inconnue'}).`);
  return parseClips(text, 'Gemini');
}

export async function askGemini({ apiKey, model = DEFAULT_GEMINI_MODEL, videoTitle = '', channel = '', clips }) {
  const tried = [model, ...GEMINI_FALLBACKS.filter((m) => m !== model)];
  let last;
  for (const m of tried) {
    try {
      return await geminiOnce({ apiKey, model: m, videoTitle, channel, clips });
    } catch (e) {
      last = e;
      if (e.status !== 404) throw e; // seul un modèle introuvable justifie d'en essayer un autre
      console.warn(`Modèle Gemini « ${m} » introuvable, essai suivant.`);
    }
  }
  throw last;
}

export async function askClaudeTitles({ apiKey, model = 'claude-sonnet-5-5', videoTitle = '', channel = '', clips }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 3000, system: SYSTEM, messages: [{ role: 'user', content: userPrompt({ videoTitle, channel, clips }) }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    const hint = res.status === 404 ? ' (modèle introuvable : change CLAUDE_MODEL)' : res.status === 429 ? ' (trop de requêtes)' : '';
    throw new Error(`Claude ${res.status}${hint} : ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  return parseClips((data.content || []).map((b) => b.text || '').join(''), 'Claude');
}

// Applique les propositions de l'IA aux extraits déjà calculés. Renvoie { clips, notice }.
export async function enhanceClips(clips, { segments = null, videoTitle = '', channel = '', name = '', link = '', ai = null, ask = null }) {
  if (!ai?.apiKey || !clips.length) return { clips, notice: '' };
  const items = clips.map((c) => ({
    start: c.start,
    end: c.end,
    text: segments ? segments.filter((s) => s.start >= c.start - 1 && s.start < c.end).map((s) => s.text).join(' ') : '',
  }));
  const askFn = ask || (ai.provider === 'claude' ? askClaudeTitles : askGemini);
  let out;
  try {
    out = await askFn({ apiKey: ai.apiKey, model: ai.model || (ai.provider === 'claude' ? 'claude-sonnet-5-5' : DEFAULT_GEMINI_MODEL), videoTitle: videoTitle || name, channel, clips: items });
  } catch (e) {
    console.warn('Titres par IA impossibles, titres simples conservés :', e.message);
    return { clips, notice: 'Titres IA indisponibles (' + (e.name === 'TimeoutError' ? 'délai dépassé' : clean(e.message).slice(0, 110)) + ') : titres simples utilisés.' };
  }
  const source = clean(videoTitle || name);
  const enhanced = clips.map((c, i) => {
    const r = out.find((x) => Number(x?.id) === i) || out[i];
    if (!r) return c;
    const titles = (Array.isArray(r.titles) ? r.titles : [])
      .map((t) => cutTo(clean(t), 100))
      .filter((t) => t.length >= 8);
    if (!titles.length) return c;
    const tags = [...new Set((Array.isArray(r.hashtags) ? r.hashtags : []).map(tagOf).filter((t) => t && t.toLowerCase() !== 'shorts'))].slice(0, 8);
    const body = clean(r.description);
    const lines = [titles[0], ''];
    if (body) lines.push(cutTo(body, 600), '');
    const T = STR[detectLang(items[i].text) || detectLang(source) || 'fr'];
    if (source) lines.push(`🎬 ${T.fromVideo} « ${cutTo(source, 90)} »${channel ? ` – ${clean(channel)}` : ''}`);
    const l = link && c.link ? c.link : '';
    if (l) lines.push(`👉 ${T.full} : ${l}`);
    lines.push(`🔔 ${T.sub}`, '', ['Shorts', ...tags].map((t) => '#' + t).join(' '));
    return {
      ...c,
      title: titles[0],
      titles,
      tags: tags.length ? tags : c.tags,
      description: lines.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 4900),
      aiTitles: true,
    };
  });
  return { clips: enhanced, notice: '' };
}
