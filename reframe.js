// Découpe un extrait d'une vidéo locale et le recadre en vertical 9:16 avec ffmpeg.
//
// Cadrage "auto" : on regarde où il se passe quelque chose dans l'image (mouvement + détails),
// puis on déplace le cadre vertical de façon fluide vers cette zone.
// Ce n'est PAS de la détection de visages : sur une scène très calme ou avec plusieurs
// personnes qui bougent en même temps, le cadre peut hésiter. Les autres modes
// (centre, gauche, droite, fond flou) restent disponibles.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// face : suit le visage (positions envoyées par le navigateur) ; auto : suit l'action de l'image.
export const FRAMINGS = ['face', 'auto', 'center', 'left', 'right', 'blur'];

const even = (n) => Math.max(2, 2 * Math.floor(n / 2));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function run(cmd, args, { collect = false, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, cwd });
    } catch (e) {
      return reject(e);
    }
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => {
      if (collect) out.push(d);
    });
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        const x = new Error(
          "ffmpeg n'est pas installé (ou pas trouvé). Installez-le avec : winget install Gyan.FFmpeg — puis fermez et rouvrez le terminal."
        );
        x.code = 'FFMPEG_MISSING';
        reject(x);
      } else {
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout: Buffer.concat(out), stderr: err });
      const tail = err.trim().split('\n').slice(-3).join(' ');
      reject(new Error(tail || `ffmpeg a échoué (code ${code}).`));
    });
  });
}

export async function ffmpegAvailable() {
  try {
    await run(FFMPEG, ['-version']);
    await run(FFPROBE, ['-version']);
    return true;
  } catch {
    return false;
  }
}

export async function probe(file) {
  const { stdout } = await run(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
    { collect: true }
  );
  const j = JSON.parse(stdout.toString() || '{}');
  const st = j.streams && j.streams[0];
  if (!st || !st.width || !st.height) throw new Error('Ce fichier ne contient pas de vidéo.');
  return { width: st.width, height: st.height, duration: Number(j.format && j.format.duration) || 0 };
}

// ---------- Analyse du cadrage ----------

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function rdp(points, tol) {
  if (points.length < 3) return points;
  const a = points[0];
  const b = points[points.length - 1];
  let worst = -1;
  let worstD = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const k = (points[i].t - a.t) / (b.t - a.t || 1);
    const d = Math.abs(points[i].x - (a.x + (b.x - a.x) * k));
    if (d > worstD) {
      worstD = d;
      worst = i;
    }
  }
  if (worstD <= tol) return [a, b];
  const left = rdp(points.slice(0, worst + 1), tol);
  const right = rdp(points.slice(worst), tol);
  return [...left.slice(0, -1), ...right];
}

// Renvoie une trajectoire [{ t, x }] : t en secondes depuis le début de l'extrait,
// x = position gauche du cadre vertical dans la vidéo source, en pixels.
export async function analyzeFraming(input, start, dur, { width, height }) {
  const cropW = even(Math.floor((height * 9) / 16));
  const centerX = even((width - cropW) / 2);
  const constant = [
    { t: 0, x: centerX },
    { t: dur, x: centerX },
  ];
  if (cropW >= width - 1) return constant;

  const GW = 192;
  const GH = even(Math.round((GW * height) / width));
  const FPS = 3;
  const { stdout } = await run(
    FFMPEG,
    [
      '-v', 'error', '-ss', String(start), '-t', String(dur), '-i', input, '-an',
      '-vf', `fps=${FPS},scale=${GW}:${GH}:flags=area,format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ],
    { collect: true }
  );

  const fsz = GW * GH;
  const n = Math.floor(stdout.length / fsz);
  if (n < 2) return constant;

  const cw = Math.max(2, Math.round((GW * cropW) / width));
  const maxPos = GW - cw;

  // Léger a priori vers le centre de l'image : à égalité, on garde un cadrage centré.
  const prior = new Float32Array(GW);
  for (let x = 0; x < GW; x++) {
    const d = (x - (GW - 1) / 2) / (GW * 0.35);
    prior[x] = 0.8 + 0.2 * Math.exp(-d * d);
  }

  // Les colonnes au milieu de la fenêtre comptent plus que celles du bord :
  // le sujet se retrouve centré dans le Short au lieu d'être collé à un bord.
  const kernel = new Float32Array(cw);
  for (let i = 0; i < cw; i++) kernel[i] = 0.35 + 0.65 * Math.sin((Math.PI * (i + 0.5)) / cw) ** 2;

  // Énergie par colonne et par image : détails (contours) + mouvement.
  const E = [];
  let prev = null;
  for (let f = 0; f < n; f++) {
    const p = stdout.subarray(f * fsz, (f + 1) * fsz);
    const grad = new Float32Array(GW);
    const mot = new Float32Array(GW);
    for (let y = 0; y < GH; y++) {
      const row = y * GW;
      for (let x = 0; x < GW; x++) {
        if (x < GW - 1) grad[x] += Math.abs(p[row + x + 1] - p[row + x]);
        if (prev) mot[x] += Math.abs(p[row + x] - prev[row + x]);
      }
    }
    grad[GW - 1] = grad[GW - 2];
    let gSum = 0;
    let mSum = 0;
    for (let x = 0; x < GW; x++) {
      gSum += grad[x];
      mSum += mot[x];
    }
    const gm = gSum / GW || 1;
    const mm = mSum / GW || 1;
    // Si l'image bouge à peine, le mouvement n'est que du bruit : on lui donne peu de poids.
    const wm = prev ? clamp(mSum / GW / GH / 2, 0, 1) : 0;
    const e = new Float32Array(GW);
    for (let x = 0; x < GW; x++) e[x] = (0.4 * (grad[x] / gm) + wm * 1.2 * (mot[x] / mm)) * prior[x];
    E.push(e);
    prev = p;
  }

  // Meilleure fenêtre verticale, en cumulant ±1 s pour éviter les sautillements.
  const R = FPS;
  const xs = [];
  for (let f = 0; f < n; f++) {
    const S = new Float32Array(GW);
    for (let k = Math.max(0, f - R); k <= Math.min(n - 1, f + R); k++) {
      for (let x = 0; x < GW; x++) S[x] += E[k][x];
    }
    let best = 0;
    let bestV = -1;
    for (let pos = 0; pos <= maxPos; pos++) {
      let v = 0;
      for (let i = 0; i < cw; i++) v += S[pos + i] * kernel[i];
      if (v > bestV) {
        bestV = v;
        best = pos;
      }
    }
    xs.push(clamp((best * width) / GW, 0, width - cropW));
  }

  // Lissage sans décalage : médiane glissante, puis moyenne exponentielle passée dans
  // les deux sens (le cadre commence à bouger un peu AVANT l'action, comme un cadreur).
  const med = xs.map((_, i) => median(xs.slice(Math.max(0, i - 2), i + 3)));
  const fwd = [];
  let acc = med[0];
  for (const v of med) {
    acc = acc + 0.4 * (v - acc);
    fwd.push(acc);
  }
  const bwd = new Array(med.length);
  acc = med[med.length - 1];
  for (let i = med.length - 1; i >= 0; i--) {
    acc = acc + 0.4 * (med[i] - acc);
    bwd[i] = acc;
  }
  const sm = fwd.map((v, i) => (v + bwd[i]) / 2);

  // Si ça bouge très peu, on garde un cadre fixe.
  if (Math.max(...sm) - Math.min(...sm) < 0.04 * width) {
    const x = even(median(sm));
    return [
      { t: 0, x },
      { t: dur, x },
    ];
  }

  let pts = sm.map((x, f) => ({ t: f / FPS, x }));
  pts = rdp(pts, 0.025 * width);
  pts[0].t = 0;
  pts[pts.length - 1].t = dur;
  return pts.map((p) => ({ t: p.t, x: even(clamp(p.x, 0, width - cropW)) }));
}

// ---------- Cadrage par détection de visages ----------
// Le navigateur envoie des échantillons { t, x } : t en secondes depuis le début de l'extrait,
// x = centre horizontal du visage entre 0 et 1 (null = aucun visage détecté à cet instant).
// On en fait une "caméra virtuelle" : le cadre reste immobile tant que le visage bouge peu,
// puis glisse doucement quand il sort de la zone centrale.

export function sanitizeSamples(raw) {
  return (Array.isArray(raw) ? raw.slice(0, 2000) : [])
    .filter((p) => p && Number.isFinite(Number(p.t)))
    .map((p) => ({
      t: Math.max(0, Number(p.t)),
      x: p.x == null || !Number.isFinite(Number(p.x)) ? null : clamp(Number(p.x), 0, 1),
      // Facultatifs (versions récentes de la page) : taille du visage, bords de l'ensemble des visages, nombre de visages.
      fh: Number.isFinite(Number(p.fh)) && Number(p.fh) > 0 ? clamp(Number(p.fh), 0.01, 1) : null,
      l: p.l != null && Number.isFinite(Number(p.l)) ? clamp(Number(p.l), 0, 1) : null,
      r: p.r != null && Number.isFinite(Number(p.r)) ? clamp(Number(p.r), 0, 1) : null,
      n: Number.isFinite(Number(p.n)) ? clamp(Math.round(Number(p.n)), 0, 20) : null,
    }))
    .sort((a, b) => a.t - b.t);
}

// ---------- Niveau de zoom intelligent ----------
// Par défaut le cadre vertical remplit toute la hauteur de la vidéo : sur un gros plan, le visage est trop serré.
// On élargit alors la zone visible (largeur cropWide >= cropW) : elle est réduite pour tenir dans 1080 px,
// et le haut/bas est comblé par un fond flou. Résultat : plan moyen avec de la marge autour de la tête.
//  - une seule personne, plutôt immobile : visage à ~18 % de la hauteur de l'image ;
//  - visage qui bouge vite ou plusieurs visages : on dézoome davantage pour ne rien couper.
const TARGET_FACE = 0.18;
export function planZoom(samples, { width, height }) {
  const cropW = even(Math.floor((height * 9) / 16));
  const none = { cropWide: cropW, zoom: 1, reason: '' };
  if (cropW >= width - 1) return none;
  const known = sanitizeSamples(samples).filter((p) => p.x !== null && p.fh !== null);
  if (known.length < 4) return none;

  let sc = Math.min(1, TARGET_FACE / median(known.map((p) => p.fh)));
  const reasons = [];
  if (sc >= 0.9) sc = 1; // déjà un plan moyen : on ne touche à rien
  else reasons.push('visage trop gros');

  const multi = known.filter((p) => (p.n || 1) >= 2 && p.l !== null && p.r !== null);
  if (multi.length / known.length >= 0.25) {
    const spans = multi.map((p) => p.r - p.l).sort((a, b) => a - b);
    const span = spans[Math.floor(spans.length * 0.9)] || spans[spans.length - 1];
    // la zone visible doit contenir tous les visages avec ~10 % de marge de chaque côté
    sc = Math.min(sc, cropW / Math.max(cropW, (span * width) / 0.8));
    reasons.push('plusieurs visages');
  }

  let dist = 0;
  let time = 0;
  for (let i = 1; i < known.length; i++) {
    const dt = known[i].t - known[i - 1].t;
    if (dt > 0 && dt < 2) {
      dist += Math.abs(known[i].x - known[i - 1].x);
      time += dt;
    }
  }
  const speed = time ? dist / time : 0;
  if (speed > 0.2) { sc *= 0.75; reasons.push('mouvement rapide'); }
  else if (speed > 0.1) { sc *= 0.87; reasons.push('mouvement'); }

  sc = clamp(sc, cropW / width, 1);
  let cropWide = even(cropW / sc);
  if (cropWide >= width * 0.96) cropWide = even(width);
  if (cropWide <= cropW + 4) return none;
  return { cropWide, zoom: Math.round((cropW / cropWide) * 100) / 100, reason: reasons.join(', ') };
}

// Retourne [{ t, x }] avec x = centre du cadre (0..1), ou null s'il y a trop peu de visages détectés.
export function cameraKeyframes(samples, { deadzone = 0.04, glideSpeed = 0.35, minGlide = 0.5, minFaceRatio = 0.3 } = {}) {
  const s0 = sanitizeSamples(samples);
  const known = s0.filter((p) => p.x !== null);
  if (s0.length < 4 || known.length / s0.length < minFaceRatio) return null;

  // Comble les trous avec la dernière position connue, puis filtre médian sur 3 points
  // (supprime les détections aberrantes isolées).
  let last = known[0].x;
  const filled = s0.map((p) => {
    if (p.x !== null) last = p.x;
    return { t: p.t, x: last };
  });
  const xs = filled.map((p) => p.x);
  const s = filled.map((p, i) => ({ t: p.t, x: median(xs.slice(Math.max(0, i - 1), i + 2)) }));

  let cam = s[0].x;
  const kfs = [{ t: 0, x: cam }];
  let busyUntil = 0;
  for (const p of s) {
    if (p.t < busyUntil) continue;
    if (Math.abs(p.x - cam) > deadzone) {
      const glide = Math.max(minGlide, Math.abs(p.x - cam) / glideSpeed);
      const t0 = Math.max(p.t, kfs[kfs.length - 1].t + 0.01);
      kfs.push({ t: t0, x: cam }); // reste en place jusqu'au début du mouvement
      kfs.push({ t: t0 + glide, x: p.x });
      cam = p.x;
      busyUntil = t0 + glide;
    }
  }
  return kfs;
}

// Trajectoire { t, x } avec x = bord gauche du cadre vertical en pixels (même format que analyzeFraming).
export function faceTrajectory(samples, dur, { width, height }, wide = null) {
  const cropW = wide || even(Math.floor((height * 9) / 16));
  if (cropW >= width - 1 && !wide) return null;
  // Plusieurs visages : on centre la caméra sur le groupe.
  const grouped = sanitizeSamples(samples).map((p) =>
    p.x !== null && (p.n || 1) >= 2 && p.l !== null && p.r !== null ? { ...p, x: (p.l + p.r) / 2 } : p,
  );
  const kfs = cameraKeyframes(grouped);
  if (!kfs) return null;
  const toLeft = (cx) => (cropW >= width ? 0 : even(clamp(Math.round(cx * width - cropW / 2), 0, width - cropW)));
  const pts = kfs.map((k) => ({ t: k.t, x: toLeft(k.x) }));
  if (pts[pts.length - 1].t < dur) pts.push({ t: dur, x: pts[pts.length - 1].x });
  return pts;
}

// Expression ffmpeg : position x du cadre en fonction du temps t (interpolation linéaire).
export function buildCropX(points) {
  const f2 = (v) => String(Math.round(v * 100) / 100);
  if (points.length === 1 || points.every((p) => p.x === points[0].x)) return String(points[0].x);
  let expr = String(points[points.length - 1].x);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i];
    const b = points[i + 1];
    const span = Math.max(0.01, b.t - a.t);
    expr = `if(lt(t,${f2(b.t)}),${a.x}+(${b.x - a.x})*(t-${f2(a.t)})/${f2(span)},${expr})`;
  }
  return expr;
}

// ---------- Découpe + recadrage ----------

// samples : positions de visage envoyées par le navigateur (cadrage "face").
// assText : contenu d'un fichier de sous-titres ASS (ou null). workDir : dossier où il est écrit.
// Logo facultatif : si logo.png (ou .jpg/.webp) existe dans le dossier du site, il est ajouté en haut à droite.
export function findLogo(baseDir) {
  for (const n of ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp']) {
    const p = path.join(baseDir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function makeShort({ input, start, end, framing, outPath, info, samples = null, assText = null, workDir = null, logo = null }) {
  const dur = end - start;
  const { width: W, height: H } = info;
  const cropW = even(Math.floor((H * 9) / 16));
  const encode = [
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  ];
  const head = ['-y', '-v', 'error', '-ss', String(start), '-t', String(dur), '-i', input];

  // Sous-titres : le fichier .ass est écrit dans workDir et lu avec un chemin relatif
  // (ffmpeg tourne dans ce dossier), ce qui évite les problèmes de ":" dans les chemins Windows.
  let assName = null;
  if (assText && workDir) {
    assName = `cap-${randomBytes(4).toString('hex')}.ass`;
    fs.writeFileSync(path.join(workDir, assName), assText, 'utf8');
  }
  const subs = assName ? `,ass=${assName}` : '';

  // Ajoute le logo (2e entrée) à un graphe de filtres dont la sortie vidéo s'appelle [v0].
  const logoGraph = (g) =>
    `${g};[1:v]scale=-2:150,format=rgba,colorchannelmixer=aa=0.9[lg];[v0][lg]overlay=W-w-40:70,format=yuv420p[v]`;
  const fcArgs = (fc) =>
    logo
      ? [...head, '-i', logo, '-filter_complex', logoGraph(fc + '[v0]'), '-map', '[v]', '-map', '0:a?', ...encode, outPath]
      : [...head, '-filter_complex', fc + '[v]', '-map', '[v]', '-map', '0:a?', ...encode, outPath];
  const wrapVf = (vf) => {
    if (!logo) return [...head, '-vf', vf, ...encode, outPath];
    return [...head, '-i', logo, '-filter_complex', logoGraph(`[0:v]${vf}[v0]`), '-map', '[v]', '-map', '0:a?', ...encode, outPath];
  };

  let args;
  let pans = 0;
  let used = framing;
  let note = '';
  let plan = { cropWide: cropW, zoom: 1, reason: '' };

  try {
    if (framing === 'blur') {
      const fc =
        '[0:v]split=2[a][b];' +
        '[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg];' +
        '[b]scale=1080:-2[fg];' +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${subs}`;
      args = fcArgs(fc);
    } else if (cropW >= W - 1) {
      // Vidéo déjà verticale (ou presque) : on remplit simplement le cadre 1080x1920.
      used = 'center';
      const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1${subs}`;
      args = wrapVf(vf);
    } else {
      let xExpr;
      if (framing === 'left') xExpr = '0';
      else if (framing === 'right') xExpr = String(even(W - cropW));
      else if (framing === 'center') xExpr = String(even((W - cropW) / 2));
      else {
        let points = null;
        if (framing === 'face') {
          plan = planZoom(samples, info);
          points = faceTrajectory(samples, dur, info, plan.cropWide > cropW ? plan.cropWide : null);
          if (!points) {
            plan = { cropWide: cropW, zoom: 1, reason: '' };
            used = 'auto';
            note = "Aucun visage détecté de façon fiable : le cadrage « suit l'action » a été utilisé à la place.";
          }
        }
        if (!points) points = await analyzeFraming(input, start, dur, info);
        pans = points.length > 2 ? points.length - 1 : 0;
        xExpr = buildCropX(points);
      }
      if (plan.cropWide > cropW) {
        // Plan moyen : zone visible élargie, posée sur un fond flou (marge au-dessus et sur les côtés de la tête).
        const fc =
          `[0:v]crop=${plan.cropWide}:${H}:x='${xExpr}':y=0,split=2[a][b];` +
          '[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg];' +
          '[b]scale=1080:-2:flags=lanczos[fg];' +
          `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${subs}`;
        args = fcArgs(fc);
        note = [note, `Cadrage aéré : ${plan.reason || 'plan moyen'}.`].filter(Boolean).join(' ');
      } else {
      const vf = `crop=${cropW}:${H}:x='${xExpr}':y=0,scale=1080:1920:flags=lanczos,setsar=1${subs}`;
      args = wrapVf(vf);
      }
    }

    await run(FFMPEG, args, { cwd: assName ? workDir : undefined });
  } finally {
    if (assName) fs.unlink(path.join(workDir, assName), () => {});
  }
  return { framing: used, pans, captions: Boolean(assName), note, zoom: plan.zoom };
}
