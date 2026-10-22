import { audioFeatures } from './audio.js';

// Détection "simple" des meilleurs moments, sans IA ni clé API.
// Principe : on fait glisser des fenêtres de 25 à 60 s sur la transcription
// et on donne une note selon des indices (accroche, énergie, émotion, coupures naturelles).

const HOOK_WORDS = [
  // français
  'attention', 'secret', 'jamais', 'toujours', 'incroyable', 'folle', 'fou', 'erreur', 'vérité',
  'personne', 'savait', 'regardez', 'écoutez', 'imaginez', 'pourquoi', 'comment', 'astuce',
  'conseil', 'problème', 'solution', 'le plus', 'meilleur', 'pire', 'choqu', 'surpris',
  // anglais
  'never', 'always', 'secret', 'crazy', 'insane', 'mistake', 'truth', 'nobody', 'imagine',
  'why', 'how', 'trick', 'tip', 'problem', 'best', 'worst', 'shocking', 'surprised', 'wait',
  'listen', 'look', 'biggest', 'amazing', 'unbelievable',
];

const EMOTION_WORDS = [
  'wow', 'oh', 'putain', 'génial', 'drôle', 'rire', 'mdr', 'ouf', 'adore', 'déteste', 'peur',
  'honte', 'heureux', 'triste', 'énervé', 'love', 'hate', 'funny', 'laugh', 'scared', 'happy',
  'sad', 'angry', 'omg', 'oh my god',
];

const LAUGH_RE = /\[(laughter|applause|rires?|applaudissements)\]|\((laughter|rires?)\)/i;
const NOISE_RE = /^\s*[\[(](music|musique|applause|applaudissements|silence)[\])]\s*$/i;

const countMatches = (text, list) => {
  const t = text.toLowerCase();
  let n = 0;
  for (const w of list) if (t.includes(w)) n++;
  return n;
};

const clean = (s) => s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

function truncate(s, n) {
  s = s.trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 20 ? cut.slice(0, sp) : cut) + '…';
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const FILLER_START = /^(alors|donc|bon|euh+|voilà|ben|bah|et|mais|ok|okay|so|well|um+|uh+|like|and|but|hello|hi|bonjour|salut|hey)\b[\s,]*/i;

// Choisit la phrase la plus accrocheuse de l'extrait (question, mots forts, chiffre, émotion), pas forcément la première.
function bestSentence(text, used) {
  const sentences = (text.split(/(?<=[.!?])\s+/).filter((x) => x.split(' ').length >= 4).slice(0, 25));
  if (!sentences.length) return text;
  let best = sentences[0];
  let bestScore = -Infinity;
  for (const raw of sentences) {
    const sent = raw.replace(FILLER_START, '').trim() || raw;
    const len = sent.length;
    let sc = countMatches(sent, HOOK_WORDS) * 3 + countMatches(sent, EMOTION_WORDS) * 2;
    if (/\?/.test(sent)) sc += 4;
    if (/!/.test(sent)) sc += 2;
    if (/\d/.test(sent)) sc += 2;
    if (len >= 25 && len <= 75) sc += 3;
    else if (len > 110) sc -= 3;
    if (used.has(truncate(sent.replace(/[.!?]+$/, ''), 60).toLowerCase())) sc -= 20;
    if (sc > bestScore) { bestScore = sc; best = sent; }
  }
  return best;
}

function uniqueTitle(title, used, idx) {
  let t = title;
  if (used.has(t.toLowerCase())) t = `${truncate(title, 50)} (${idx + 1})`;
  used.add(t.toLowerCase());
  return t;
}

// segments : [{ start, dur, text }] en secondes
// energy (facultatif) : volume du fichier vidéo (audioEnergy). Si présent, le choix des passages combine le texte ET le son.
export function findClipsSimple(segments, totalSeconds, maxClips = 5, targetSeconds = 40, energy = null) {
  const T = Math.min(90, Math.max(15, Number(targetSeconds) || 40));
  const segs = segments.filter((s) => !NOISE_RE.test(s.text));
  if (segs.length < 3) return { video_summary: '', clips: [] };

  const startsAfterPause = segs.map((s, i) => {
    if (i === 0) return true;
    const prev = segs[i - 1];
    return s.start - (prev.start + prev.dur) > 0.6;
  });
  const endsBeforePause = segs.map((s, i) => {
    if (i === segs.length - 1) return true;
    const next = segs[i + 1];
    return next.start - (s.start + s.dur) > 0.6;
  });

  const candidates = [];
  const targets = [0.65 * T, T, 1.4 * T];
  const minDur = Math.max(10, 0.45 * T);
  const maxDur = Math.min(95, 1.9 * T);
  const minWords = Math.round((25 * T) / 40);

  for (let i = 0; i < segs.length; i++) {
    for (const target of targets) {
      let j = i;
      while (j < segs.length - 1 && segs[j].start + segs[j].dur - segs[i].start < target) j++;
      const start = segs[i].start;
      const end = segs[j].start + segs[j].dur;
      const dur = end - start;
      if (dur < minDur || dur > maxDur) continue;

      const text = segs.slice(i, j + 1).map((s) => s.text).join(' ');
      const plain = clean(text);
      const words = plain.split(' ').filter(Boolean).length;
      if (words < minWords) continue;

      const opening = clean(segs.slice(i, Math.min(j, i + 3) + 1).map((s) => s.text).join(' '));
      const wps = words / dur; // rythme de parole

      let score = 0;
      const why = [];

      // Accroche dans les premières secondes
      let hook = 0;
      if (/\?/.test(opening)) hook += 8;
      hook += Math.min(10, countMatches(opening, HOOK_WORDS) * 5);
      if (/\d/.test(opening)) hook += 3;
      if (hook > 0) why.push("une accroche forte dès le début");
      score += hook;

      // Énergie : rythme de parole soutenu
      if (wps >= 2.4) { score += 10; why.push('un rythme de parole soutenu'); }
      else if (wps >= 1.8) score += 5;
      else if (wps < 1.0) score -= 8;

      // Ponctuation expressive et émotion
      const excl = (text.match(/!/g) || []).length;
      const quest = (text.match(/\?/g) || []).length;
      const emo = countMatches(plain, EMOTION_WORDS);
      const laughs = segs.slice(i, j + 1).filter((s) => LAUGH_RE.test(s.text)).length;
      const expressive = Math.min(12, excl * 2 + quest * 1.5 + emo * 2 + laughs * 6);
      if (expressive >= 4) why.push('de l’émotion ou de l’humour');
      score += expressive;

      // Mots forts répartis dans l'extrait
      const hooks = Math.min(10, countMatches(plain, HOOK_WORDS) * 2);
      score += hooks;

      // Coupures naturelles au début et à la fin
      if (startsAfterPause[i]) score += 4;
      if (endsBeforePause[j]) { score += 5; why.push('une fin nette'); }
      if (/[.!?]\s*$/.test(segs[j].text)) score += 3;

      // Durée proche de la durée visée
      if (dur >= 0.65 * T && dur <= 1.25 * T) score += 5;

      // Début mou ("alors euh…", "bonjour") : on préfère démarrer sur une phrase plus directe.
      if (FILLER_START.test(opening) && !/\?/.test(opening)) score -= 3;

      // Son : accroche dite avec énergie, pics de voix, expressivité, temps morts.
      if (energy) {
        const af = audioFeatures(energy, start, end);
        score += af.delta;
        why.push(...af.reasons.filter((r) => !/pénalisé/.test(r)));
        if (hook > 0 && af.hookLevel > 0.3) {
          score += 4;
          why.push('une accroche forte et dite avec énergie');
        }
      }

      candidates.push({ i, j, start, end, dur, score, opening: plain, plain, why });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const picked = [];
  for (const c of candidates) {
    if (picked.length >= maxClips) break;
    if (picked.some((p) => c.start < p.end + 5 && c.end > p.start - 5)) continue;
    picked.push(c);
  }
  if (!picked.length) return { video_summary: '', clips: [] };

  const best = picked[0].score || 1;
  const usedTitles = new Set();
  const clips = picked.map((c, idx) => {
    const firstSentence = bestSentence(c.plain || c.opening, usedTitles);
    const hookText = truncate(firstSentence, 110);
    const reasons = [...new Set(c.why)];
    return {
      start: c.start,
      end: c.end,
      score: Math.max(30, Math.min(95, Math.round((c.score / best) * 90))),
      audioScored: Boolean(energy),
      title: uniqueTitle(capitalize(truncate(firstSentence.replace(/[.!?]+$/, ''), 60)), usedTitles, idx),
      hook: hookText,
      reason: reasons.length
        ? `Ce passage se distingue par ${reasons.slice(0, 3).join(', ')}.`
        : 'Passage dense et assez autonome, à vérifier avant de publier.',
    };
  });

  return {
    video_summary: energy
      ? 'Analyse simple (sans IA) : classement basé sur les accroches du texte combinées au son (pics de voix, énergie).'
      : 'Analyse simple (sans IA) : classement basé sur le rythme, l’émotion et les accroches.',
    clips,
  };
}
