// Titres, description et hashtags automatiques d'un Short, d'après le contenu :
// nom de la vidéo, titre YouTube d'origine, texte parlé (si on l'a) et phrase d'accroche.
// Règles simples, sans IA : on reconnaît le type de contenu (clip musical, podcast/émission, jeu, tuto, humour…)
// et on applique des modèles de titres adaptés. Plusieurs idées de titres sont proposées.
import { topKeywords } from './keywords.js';
import { detectLang, STR } from './lang.js';

const MUSIC_RE = /clip officiel|official (music )?video|official audio|audio officiel|lyrics?( video)?|visuali[sz]er|freestyle|\(clip\)|\bclip\b|\bremix\b|live session/i;
const TYPES = [
  ['gaming', /gameplay|let'?s play|minecraft|fortnite|\bgta\b|fifa|call of duty|\bcod\b|valorant|roblox|speedrun|\bgaming\b/i, ['Gaming', 'Gameplay', 'JeuVidéo']],
  ['humor', /sketch|humou?r|blague|\bprank\b|drôle|funny|stand[- ]?up|parodie/i, ['Humour', 'Drôle', 'Sketch']],
  ['tuto', /\btuto|astuce|\btips?\b|how to|comment (faire|réussir|gagner)|guide|apprendre|formation/i, ['Tuto', 'Astuce', 'Conseils']],
  ['sport', /\bfoot\b|football|basket|\bnba\b|\bufc\b|\bmma\b|match|boxe|tennis|\bf1\b|entra[iî]nement|fitness|musculation/i, ['Sport', 'Highlights']],
  ['show', /podcast|interview|[ée]pisode|\bep\.? ?\d|#\d+|\(ft\b|\bft\.? |débat|talk|emission|émission|replay/i, ['Podcast', 'Interview']],
];
const TYPE_TAGS = { music: ['NouveauClip', 'NouveauSon', 'Musique'] };
const FILLER_START = /^(alors|donc|bon|euh+|voilà|ben|bah|et|mais|ok|okay|so|well|um+|uh+|like|and|but|hello|hi|bonjour|salut|hey)\b[\s,]*/i;

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function cut(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const c = s.slice(0, n - 1);
  const sp = c.lastIndexOf(' ');
  return (sp > n * 0.5 ? c.slice(0, sp) : c).replace(/[\s,;:–-]+$/, '') + '…';
}
const uniq = (arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];

// Retire l'extension, les étiquettes (Clip Officiel), [HD], 4K… et les symboles inutiles.
export function cleanName(name = '') {
  return String(name)
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/[\[(][^\])]*(clip|official|officiel|lyrics?|audio|video|vidéo|visuali[sz]er|hd|4k|1080p?|720p?|remastered?)[^\])]*[\])]/gi, ' ')
    .replace(/\b(4k|hd|1080p?|720p?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–|]+|[\s\-–|]+$/g, '')
    .trim();
}

function tagOf(s) {
  const t = String(s || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(cap)
    .join('');
  return t.length >= 3 && t.length <= 30 ? t : '';
}

function detectType(name, text) {
  if (MUSIC_RE.test(name)) return { type: 'music', tags: TYPE_TAGS.music };
  const hay = `${name} ${String(text || '').slice(0, 3000)}`;
  for (const [type, re, tags] of TYPES) if (re.test(name) || (type !== 'show' && re.test(hay))) return { type, tags };
  return { type: 'general', tags: [] };
}

function splitArtist(clean) {
  const m = clean.match(/^(.{2,40}?)\s[-–|]\s(.{1,60})$/);
  if (m) return { artist: m[1].trim(), track: m[2].trim() };
  return null;
}

function cleanHook(h) {
  let s = String(h || '').replace(/&gt;|&lt;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[>»›\-–—•*\s]+/, '').replace(/^\[[^\]]{1,20}\]\s*/, ''); // marques de dialogue des sous-titres (>>, - …)
  s = s.replace(FILLER_START, '').replace(/[.!?…]+$/, '').trim();
  return cap(s);
}

// ctx : { name, videoTitle, channel, link, text, hook, part, title }  (title : titre déjà choisi, gardé en première idée)
export function buildMetadata(ctx = {}) {
  const { videoTitle = '', channel = '', link = '', text = '', hook = '', part = 0 } = ctx;
  const rawName = ctx.name || videoTitle || '';
  const name = cleanName(rawName);
  const source = cleanName(videoTitle) || name; // pour « Extrait de … »
  const { type, tags: typeTags } = detectType(rawName || videoTitle, text);
  const hookT = cleanHook(hook);
  const hasHook = hookT.length >= 12 && !/^moment fort/i.test(hookT);
  const lang = detectLang(`${text} ${hook}`) || detectLang(`${videoTitle} ${rawName}`) || 'fr';
  const T = STR[lang];
  const suffix = part ? ` (${T.part} ${part})` : '';

  let titles = [];
  let line = '';
  if (type === 'music') {
    const sp = splitArtist(name);
    if (sp) {
      titles = T.music(sp.artist, sp.track);
      line = T.musicLine(sp.artist, sp.track);
    } else {
      titles = T.musicNoArtist(name);
      line = T.musicNoArtistLine(name);
    }
  } else if (hasHook) {
    const h = cut(hookT, 62);
    titles = [h, `${h} 👀`];
    const show = name.replace(/\s*[\[(][^\])]*[\])]/g, '').trim();
    titles.push(type === 'show' && show ? `${cut(show, 30)} : ${cut(hookT, 55)}` : `${T.watch} ${cut(hookT, 60)}`);
    line = hookT.length > 62 ? `💬 « ${cut(hookT, 140)} »` : '';
  } else if (name) {
    titles = type === 'gaming' ? [`${name} : ${T.bestLow} 🎮`, `${name} 🔥`] : type === 'tuto' ? [`${name} : ${T.tip}`, `${name} 🔥`] : [`${name} 🔥`, `${T.dontMiss} ${name}`];
    titles = titles.map((t, i) => (i === 0 && suffix ? t.replace(/ ?[🔥🎮💡]$/u, '') + suffix : t));
    titles.push(`${name} : ${T.extract}${suffix}`);
  } else {
    titles = [`${T.best}${suffix} 🔥`];
  }
  if (ctx.title && type !== 'music') titles = [ctx.title, ...titles];
  titles = uniq(titles.map((t) => cut(t, 100)));

  // Hashtags : #Shorts + type + mots-clés du texte + nom (artiste / émission), 8 maximum.
  const kw = topKeywords(text || hook, 3).map(cap);
  const nameTag = tagOf(type === 'music' ? name : splitArtist(name)?.artist || name);
  const tags = uniq(['Shorts', ...typeTags, ...kw, nameTag]).slice(0, 8);

  const lines = [];
  lines.push(titles[0]);
  lines.push('');
  if (line && line !== titles[0]) lines.push(line);
  if (source) lines.push(`🎬 ${type === 'music' ? T.fromClip : T.fromVideo} « ${cut(source, 90)} »${channel ? ` – ${channel}` : ''}`);
  if (link) lines.push(`👉 ${T.full} : ${link}`);
  lines.push(`🔔 ${T.sub}`);
  lines.push('');
  lines.push(tags.map((t) => '#' + t).join(' '));

  return { type, lang, title: titles[0], titles, description: lines.join('\n').replace(/\n{3,}/g, '\n\n'), tags: tags.filter((t) => t !== 'Shorts') };
}
