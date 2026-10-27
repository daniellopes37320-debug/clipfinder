// Sous-titres incrustés : on fabrique un fichier ASS (lu par ffmpeg) à partir de la transcription.
// Style "Shorts" : 3 à 4 mots à la fois, gros, blanc avec contour noir, le mot prononcé passe en jaune.

const WORDS_PER_CHUNK = 4;
const MAX_CHARS = 26;

function cs(t) {
  // Temps ASS : H:MM:SS.cc
  const v = Math.max(0, t);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  const c = Math.min(99, Math.floor((v - Math.floor(v)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const clean = (s) =>
  String(s)
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [Musique], (rires)…
    .replace(/[{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// segments : [{ start, dur, text }] en secondes dans la vidéo entière
// Retourne le texte du fichier .ass, ou null s'il n'y a aucun mot à afficher.
export function buildAss({ segments, start, end, width = 1080, height = 1920 }) {
  // 1) Chaque mot reçoit un temps de début/fin proportionnel à sa longueur dans son segment.
  const words = [];
  let lastEnd = 0;
  let prev = []; // derniers mots affichés, pour ignorer les répétitions des sous-titres automatiques YouTube
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  for (const seg of segments || []) {
    const sStart = seg.start;
    const sEnd = seg.start + Math.max(0.2, seg.dur);
    if (sEnd <= start || sStart >= end) continue;
    let ws = clean(seg.text).split(' ').filter(Boolean);
    // Les sous-titres automatiques répètent la fin de la ligne précédente : on retire ce début déjà dit.
    for (let k = Math.min(prev.length, ws.length, 12); k > 0; k--) {
      if (prev.slice(-k).every((p, i) => p === norm(ws[i]))) {
        ws = ws.slice(k);
        break;
      }
    }
    if (!ws.length) continue;
    prev = [...prev, ...ws.map(norm)].slice(-12);
    const total = ws.reduce((a, w) => a + w.length + 1, 0);
    let t = Math.max(sStart, lastEnd); // jamais deux mots en même temps
    const span = Math.max(0.2, sEnd - t);
    for (const w of ws) {
      const d = ((w.length + 1) / total) * span;
      words.push({ w, a: t, b: t + d });
      t += d;
    }
    lastEnd = t;
  }
  const inClip = words
    .filter((x) => x.b > start && x.a < end)
    .map((x) => ({ w: x.w, a: Math.max(start, x.a) - start, b: Math.min(end, x.b) - start }));
  if (!inClip.length) return null;

  // 2) Regroupement en petits blocs.
  const chunks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
  };
  for (const x of inClip) {
    const len = cur.reduce((a, y) => a + y.w.length + 1, 0) + x.w.length;
    if (cur.length >= WORDS_PER_CHUNK || (cur.length && len > MAX_CHARS)) flush();
    cur.push(x);
  }
  flush();

  // 3) Lignes ASS : le bloc reste affiché jusqu'au suivant (si l'écart est court).
  const lines = chunks.map((c, i) => {
    const a = c[0].a;
    let b = c[c.length - 1].b;
    const nextA = i + 1 < chunks.length ? chunks[i + 1][0].a : null;
    if (nextA !== null && nextA - b < 0.6) b = nextA;
    else b += 0.15;
    const text = c
      .map((x) => {
        const k = Math.max(1, Math.round((x.b - x.a) * 100));
        return `{\\k${k}}${x.w}`;
      })
      .join(' ');
    return `Dialogue: 0,${cs(a)},${cs(b)},Cap,,0,0,0,,${text}`;
  });

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Jaune = mot déjà prononcé, blanc = mot à venir, contour noir épais, centré en bas
    'Style: Cap,Arial,82,&H0000E5FF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,2,70,70,330,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines,
    '',
  ].join('\n');
}

// Lit un fichier de sous-titres .srt ou .vtt (export de CapCut, Premiere, DaVinci, YouTube Studio…).
// Retourne [{ start, dur, text }] en secondes.
export function parseSubtitles(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const timeRe = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  const toSec = (s) => {
    const p = s.replace(',', '.').split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  const segs = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => timeRe.test(l));
    if (i < 0) continue; // en-tête WEBVTT, NOTE, numéro seul…
    const m = lines[i].match(timeRe);
    const a = toSec(m[1]);
    const b = toSec(m[2]);
    const t = lines
      .slice(i + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '') // <i>, <c>, <00:00:01.000>
      .replace(/\{[^}]*\}/g, '') // {\an8}
      .replace(/&nbsp;/g, ' ')
      .replace(/(?:&gt;|>){2,}\s*/g, ' ') // « >> » : changement de locuteur
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || !(b > a)) continue;
    segs.push({ start: a, dur: b - a, text: t });
  }
  segs.sort((x, y) => x.start - y.start);
  // Les sous-titres automatiques VTT répètent parfois la même ligne : on fusionne.
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.text === s.text && s.start - (prev.start + prev.dur) < 0.3) {
      prev.dur = s.start + s.dur - prev.start;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}
