// Analyse du son d'un fichier vidéo (volume par tranche de 0,5 s), sans IA :
//  - refineClips : ajuste les extraits proposés (score + début/fin sur un silence)
//  - clipsFromAudio : propose des extraits quand il n'y a pas de sous-titres
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const STEP = 0.5;
const RATE = 8000;
const WIN = RATE * STEP;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function audioEnergy(file) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], {
        windowsHide: true,
      });
    } catch (e) {
      return reject(e);
    }
    const rms = [];
    let carry = Buffer.alloc(0);
    let sumSq = 0;
    let n = 0;
    let err = '';
    p.stdout.on('data', (buf) => {
      const b = carry.length ? Buffer.concat([carry, buf]) : buf;
      const usable = b.length - (b.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = b.readInt16LE(i) / 32768;
        sumSq += v * v;
        n++;
        if (n === WIN) {
          rms.push(Math.sqrt(sumSq / n));
          sumSq = 0;
          n = 0;
        }
      }
      carry = b.subarray(usable);
    });
    p.stderr.on('data', (d) => (err = (err + d).slice(-500)));
    p.on('error', (e) => {
      const x = new Error(
        e.code === 'ENOENT'
          ? "ffmpeg n'est pas installé (ou pas trouvé). Installez-le avec : winget install Gyan.FFmpeg"
          : e.message,
      );
      x.code = e.code === 'ENOENT' ? 'FFMPEG_MISSING' : e.code;
      reject(x);
    });
    p.on('close', (code) => {
      if (n > WIN / 4) rms.push(Math.sqrt(sumSq / n));
      if (code === 0 && rms.length) return resolve({ step: STEP, rms });
      reject(new Error(rms.length ? err.trim() || 'Lecture du son impossible.' : "Ce fichier n'a pas de piste audio."));
    });
  });
}

function stats(rms) {
  const db = rms.map((v) => 20 * Math.log10(v + 1e-5));
  const sorted = [...db].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const p50 = q(0.5);
  return { db, p25: q(0.25), p50, p90: q(0.9), span: Math.max(3, q(0.95) - p50) };
}

const statsCache = new WeakMap();
function cachedStats(energy) {
  if (!statsCache.has(energy)) statsCache.set(energy, stats(energy.rms));
  return statsCache.get(energy);
}

// Indices sonores d'un passage [start, end] (en secondes) : bonus de score + raisons lisibles.
//  - niveau : le son est-il plus fort que dans le reste de la vidéo ?
//  - accroche : énergie des 4 premières secondes (un début mou fait décrocher) ;
//  - pics : tranches très fortes (rires, éclats de voix) et hausses brusques de volume (changements de ton) ;
//  - expressivité : variation du volume (voix monotone ou vivante) ;
//  - temps mort : part de silence dans le passage (pénalité).
// Hauteur de la voix non mesurée : les « changements de ton » sont estimés par les variations de volume.
export function audioFeatures(energy, start, end) {
  if (!energy || !energy.rms || energy.rms.length < 20) return { delta: 0, reasons: [] };
  const { db, p25, p50, p90, span } = cachedStats(energy);
  const step = energy.step;
  const idx = (t) => clamp(Math.floor(t / step), 0, db.length - 1);
  const a = idx(start);
  const b = Math.max(a, idx(end));
  const cnt = b - a + 1;
  let sum = 0;
  let loud = 0;
  let quiet = 0;
  let onsets = 0;
  for (let i = a; i <= b; i++) {
    sum += db[i];
    if (db[i] > p90) loud++;
    if (db[i] < p25) quiet++;
    if (i > a && db[i] - db[i - 1] > 0.5 * span && db[i] > p50) onsets++;
  }
  const mean = sum / cnt;
  let varSum = 0;
  for (let i = a; i <= b; i++) varSum += (db[i] - mean) ** 2;
  const dyn = clamp(Math.sqrt(varSum / cnt) / (span * 0.6), 0, 1);
  const hookEnd = Math.min(b, a + Math.round(4 / step) - 1);
  let hs = 0;
  for (let i = a; i <= hookEnd; i++) hs += db[i];
  const hookLevel = (hs / (hookEnd - a + 1) - p50) / span;
  const level = (mean - p50) / span;
  const peaks = loud / cnt;
  const onsetRate = onsets / Math.max(1, (cnt * step) / 10);
  const quietFrac = quiet / cnt;

  const delta = Math.round(
    10 * clamp(level, -0.5, 1) +
      8 * clamp(hookLevel, -0.5, 1) +
      5 * dyn +
      4 * clamp(onsetRate / 3, 0, 1) +
      (peaks >= 0.15 ? 3 : 0) -
      12 * Math.max(0, quietFrac - 0.3),
  );
  const reasons = [];
  if (hookLevel > 0.4) reasons.push('un début dynamique à l’écoute');
  if (peaks >= 0.15 || onsetRate >= 2) reasons.push('des pics de voix (rires, éclats, emphase)');
  if (dyn >= 0.6) reasons.push('une voix expressive (le volume varie beaucoup)');
  if (level > 0.4 && !reasons.length) reasons.push('un son plus énergique que le reste de la vidéo');
  if (quietFrac > 0.4) reasons.push('beaucoup de silences (pénalisé)');
  return { delta, reasons, hookLevel, level, peaks, dyn, quietFrac };
}

// Retire le temps mort au début et à la fin d'un passage (garde ~0,3 s avant la première parole et ~0,5 s après la dernière).
export function trimDeadAir(energy, start, end, minDur = 10) {
  if (!energy || !energy.rms || energy.rms.length < 20) return { start, end };
  const { db, p25 } = cachedStats(energy);
  const step = energy.step;
  const idx = (t) => clamp(Math.floor(t / step), 0, db.length - 1);
  let s = idx(start);
  let e = idx(end);
  while (s < e - 1 && db[s] < p25) s++;
  while (e > s + 1 && db[e] < p25) e--;
  const ns = Math.max(start, s * step - 0.3);
  const ne = Math.min(end, (e + 1) * step + 0.5);
  return ne - ns >= minDur ? { start: ns, end: ne } : { start, end };
}

// clips : [{ start, end, score, reason, ... }] en secondes. Renvoie une copie ajustée, triée par score.
// Un clip marqué audioScored (déjà noté avec le son lors du choix) n'est pas noté deux fois.
export function refineClips(clips, energy) {
  const { rms } = energy || {};
  const step = energy && energy.step;
  if (!rms || rms.length < 20) return clips;
  const { db, p25, p50, p90, span } = cachedStats(energy);
  const idx = (t) => clamp(Math.floor(t / step), 0, db.length - 1);
  // Tranche calme la plus proche de l'instant visé (dans la plage donnée).
  const nearestQuiet = (from, to, target) => {
    let best = null;
    for (let i = idx(from); i <= idx(to); i++) {
      if (db[i] >= p25) continue;
      if (best === null || Math.abs(i * step - target) < Math.abs(best * step - target)) best = i;
    }
    return best;
  };

  return clips
    .map((c) => {
      let { start, end } = c;
      // Début et fin calés sur un silence proche, pour ne pas couper une phrase en plein milieu.
      const qs = nearestQuiet(start - 3, start + 1.5, start);
      if (qs !== null) {
        const ns = Math.max(0, Math.round((qs + 1) * step));
        if (end - ns >= 12 && end - ns <= 90) start = ns;
      }
      const qe = nearestQuiet(end - 3, end + 3, end);
      if (qe !== null) {
        const ne = Math.round(qe * step + step / 2);
        if (ne - start >= 12 && ne - start <= 90) end = ne;
      }

      // Temps mort au début / à la fin : on le coupe.
      ({ start, end } = trimDeadAir(energy, start, end));
      start = Math.round(start * 10) / 10;
      end = Math.round(end * 10) / 10;

      if (c.audioScored) return { ...c, start, end };
      const f = audioFeatures(energy, start, end);
      let reason = c.reason || '';
      if (f.reasons.length) reason += ` À l’écoute : ${f.reasons.join(', ')}.`;
      return { ...c, start, end, score: clamp(Math.round((c.score || 0) + f.delta), 0, 100), reason: reason.trim() };
    })
    .sort((x, y) => y.score - x.score);
}

// Sans texte : on choisit les fenêtres les plus énergiques, qui commencent et finissent sur un silence.
export function clipsFromAudio(energy, totalSeconds, target = 40, max = 5) {
  const { step, rms } = energy;
  if (!rms || rms.length < 20) return [];
  const { db, p25, p50, p90, span } = stats(rms);
  const winLen = Math.max(8, Math.round(target / step));
  if (db.length <= winLen) return [];

  const cands = [];
  for (let i = 2; i + winLen < db.length - 2; i += 2) {
    let sum = 0;
    let loud = 0;
    for (let k = i; k < i + winLen; k++) {
      sum += db[k];
      if (db[k] > p90) loud++;
    }
    const mean = sum / winLen;
    if (mean < p50) continue;
    const quiet = (a, b) => Math.min(...db.slice(a, b)) < p25;
    const score =
      10 * clamp((mean - p50) / span, 0, 1.5) + 10 * (loud / winLen) + (quiet(i - 2, i + 1) ? 2 : 0) + (quiet(i + winLen - 1, i + winLen + 2) ? 2 : 0);
    cands.push({ i, score });
  }
  cands.sort((a, b) => b.score - a.score);

  const picked = [];
  for (const c of cands) {
    if (picked.length >= max) break;
    if (picked.some((p) => Math.abs(p.i - c.i) < winLen + 10)) continue;
    picked.push(c);
  }
  if (!picked.length) return [];
  const hi = picked[0].score;
  const lo = picked[picked.length - 1].score;
  return picked.map((c) => {
    const t = trimDeadAir(energy, Math.round(c.i * step), Math.min(Math.ceil(totalSeconds), Math.round((c.i + winLen) * step)));
    return { ...c, _t: t };
  }).map((c) => ({
    start: Math.round(c._t.start),
    end: Math.round(c._t.end),
    score: hi === lo ? 80 : Math.round(55 + (35 * (c.score - lo)) / (hi - lo)),
    hook: '',
    reason: 'Passage le plus énergique à l’écoute (analyse sonore, sans texte).',
  }));
}
