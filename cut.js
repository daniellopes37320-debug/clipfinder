// Routes pour créer des Shorts à partir d'un fichier vidéo local :
//   GET  /api/status        -> ffmpeg est-il installé ?
//   POST /api/upload        -> reçoit le fichier vidéo (corps brut), le range dans tmp/
//   POST /api/cut           -> découpe + recadre 9:16 (+ sous-titres), le résultat va dans output/
//   POST /api/refine        -> ajuste les extraits proposés grâce au son du fichier
//   POST /api/analyze-file  -> propose des extraits à partir du son seul (vidéo sans sous-titres)
//   GET  /api/history       -> liste des Shorts déjà créés
// Les handlers n'utilisent que l'API standard de Node (req/res), sans dépendance.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { probe, makeShort, ffmpegAvailable, FRAMINGS, sanitizeSamples, findLogo } from './reframe.js';
import { buildAss, parseSubtitles } from './captions.js';
import { audioEnergy, refineClips, clipsFromAudio } from './audio.js';
import { finalizeClips, relabel, analyzeSegments } from './analysis.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const MAX_CLIP_SECONDS = 120;
// Taille maximale d'un fichier envoyé (réglable avec MAX_UPLOAD_GB dans .env, 4 Go par défaut).
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_GB) > 0 ? Number(process.env.MAX_UPLOAD_GB) : 4) * 1024 ** 3;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

// getSegments(clé) -> transcription mise en cache par le serveur (ou undefined)
// setSegments(clé, segments) -> la garde en mémoire (sous-titres importés avec un fichier)
export function createCutHandlers({ baseDir, getSegments = () => undefined, setSegments = () => {}, apiKey = '', model = '' }) {
  const tmpDir = path.join(baseDir, 'tmp');
  const outputDir = path.join(baseDir, 'output');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Ménage au démarrage : les fichiers envoyés depuis plus de 24 h sont supprimés.
  const now = Date.now();
  for (const f of fs.readdirSync(tmpDir)) {
    try {
      const p = path.join(tmpDir, f);
      if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p);
    } catch {
      /* on ignore */
    }
  }

  const energyCache = new Map(); // uploadId -> { step, rms }
  const uploadNames = new Map(); // uploadId -> nom du fichier d'origine (pour proposer titre et description)

  function findUpload(uploadId) {
    if (!/^[a-f0-9]{8}$/.test(String(uploadId))) return null;
    const name = fs.readdirSync(tmpDir).find((f) => f.startsWith(uploadId + '.'));
    return name ? path.join(tmpDir, name) : null;
  }

  async function getEnergy(uploadId, file) {
    if (!energyCache.has(uploadId)) energyCache.set(uploadId, await audioEnergy(file));
    return energyCache.get(uploadId);
  }

  const fail = (res, err) => {
    console.error(err);
    json(res, err.code === 'FFMPEG_MISSING' ? 501 : 500, { error: err.message || 'Erreur inattendue.' });
  };

  async function status(req, res) {
    json(res, 200, { ffmpeg: await ffmpegAvailable() });
  }

  function upload(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const name = url.searchParams.get('name') || 'video.mp4';
    const ext = path.extname(name).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      return json(res, 400, { error: 'Format non pris en charge (mp4, mov, mkv, webm, avi, m4v).' });
    }

    const declared = Number(req.headers['content-length']);
    if (declared > MAX_UPLOAD_BYTES) {
      req.resume();
      return json(res, 413, { error: `Fichier trop gros (maximum ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 3)} Go, réglable avec MAX_UPLOAD_GB dans .env).` });
    }

    const id = randomBytes(4).toString('hex');
    uploadNames.set(id, name.slice(0, 200));
    if (uploadNames.size > 100) uploadNames.delete(uploadNames.keys().next().value);
    const file = path.join(tmpDir, id + ext);
    const ws = fs.createWriteStream(file);
    let failed = false;
    const abort = (code, msg) => {
      if (failed) return;
      failed = true;
      ws.destroy();
      fs.unlink(file, () => {});
      if (!res.headersSent) json(res, code, { error: msg });
    };

    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        req.unpipe(ws);
        abort(413, 'Fichier trop gros (voir MAX_UPLOAD_GB dans .env).');
        req.resume();
      }
    });
    req.on('error', () => abort(400, 'Envoi interrompu.'));
    req.on('aborted', () => abort(400, 'Envoi interrompu.'));
    ws.on('error', (e) => abort(500, "Impossible d'écrire le fichier : " + e.message));
    ws.on('finish', async () => {
      if (failed) return;
      try {
        const info = await probe(file);
        json(res, 200, { uploadId: id, ...info });
      } catch (e) {
        fs.unlink(file, () => {});
        if (e.code === 'FFMPEG_MISSING') return json(res, 501, { error: e.message, code: e.code });
        json(res, 400, { error: "Ce fichier n'est pas une vidéo lisible." });
      }
    });
    req.pipe(ws);
  }

  async function cut(req, res) {
    try {
      const { uploadId, start, end, framing = 'auto', captions = false, videoId = null, captionKey = null, samples = null } = req.body || {};
      const input = findUpload(uploadId);
      if (!/^[a-f0-9]{8}$/.test(String(uploadId))) {
        return json(res, 400, { error: 'Fichier inconnu : renvoyez la vidéo.' });
      }
      const s = Number(start);
      const e = Number(end);
      if (!(s >= 0) || !(e > s) || e - s > MAX_CLIP_SECONDS) {
        return json(res, 400, { error: 'Timecodes invalides.' });
      }
      if (!FRAMINGS.includes(framing)) return json(res, 400, { error: 'Cadrage inconnu.' });
      if (!input) return json(res, 404, { error: 'Fichier introuvable (envoi expiré ?). Renvoyez la vidéo.' });

      const info = await probe(input);
      if (s >= info.duration) {
        return json(res, 400, {
          error: `Ce fichier dure ${Math.round(info.duration)} s : l'extrait demandé commence après la fin. Est-ce bien la même vidéo ?`,
        });
      }
      const realEnd = Math.min(e, info.duration);

      // Sous-titres : on a besoin de la transcription de la vidéo YouTube analysée.
      const notes = [];
      let assText = null;
      if (captions) {
        const segKey = typeof captionKey === 'string' ? captionKey : videoId;
        const segs = typeof segKey === 'string' ? getSegments(segKey) : undefined;
        assText = segs ? buildAss({ segments: segs, start: s, end: realEnd }) : null;
        if (!assText) notes.push('Pas de sous-titres disponibles pour cet extrait : Short créé sans sous-titres.');
      }

      const outName = `short-${randomBytes(3).toString('hex')}-${Math.round(s)}s-${framing}.mp4`;
      const result = await makeShort({
        input,
        start: s,
        end: realEnd,
        framing,
        outPath: path.join(outputDir, outName),
        info,
        samples: framing === 'face' ? sanitizeSamples(samples) : null,
        assText,
        workDir: tmpDir,
        logo: findLogo(baseDir),
      });
      if (result.note) notes.unshift(result.note);
      json(res, 200, {
        url: '/clips/' + outName,
        name: outName,
        framing: result.framing,
        pans: result.pans,
        captions: result.captions,
        note: notes.join(' '),
      });
    } catch (err) {
      fail(res, err);
    }
  }

  // Ajuste les extraits (début/fin calés sur un silence, score selon l'énergie du son).
  async function refine(req, res) {
    try {
      const { uploadId, videoId = null, clips } = req.body || {};
      const file = findUpload(uploadId);
      if (!file) return json(res, 404, { error: 'Fichier introuvable : renvoyez la vidéo.' });
      if (!Array.isArray(clips) || !clips.length) return json(res, 400, { error: 'Aucun extrait à ajuster.' });
      const clean = clips.slice(0, 20).map((c) => ({
        ...c,
        start: Number(c.start) || 0,
        end: Number(c.end) || 0,
        score: Number(c.score) || 0,
      }));
      const energy = await getEnergy(uploadId, file);
      const refined = refineClips(clean, energy).map((c) => relabel(c, typeof videoId === 'string' ? videoId : null));
      json(res, 200, { clips: refined });
    } catch (err) {
      if (/piste audio|Lecture du son/.test(err.message || '')) return json(res, 422, { error: err.message });
      fail(res, err);
    }
  }

  // Sans sous-titres : propose des extraits d'après l'énergie sonore du fichier.
  async function analyzeFile(req, res) {
    try {
      const { uploadId, target = 40, subtitles = null } = req.body || {};
      const file = findUpload(uploadId);
      if (!file) return json(res, 404, { error: 'Fichier introuvable : renvoyez la vidéo.' });
      const info = await probe(file);
      const T = Math.min(90, Math.max(15, Number(target) || 40));

      // Sous-titres fournis avec le fichier (.srt / .vtt) : on analyse le texte, comme pour un lien YouTube.
      let segments = null;
      if (typeof subtitles === 'string' && subtitles.trim()) {
        segments = parseSubtitles(subtitles.slice(0, 3_000_000));
        if (segments.length < 3) {
          return json(res, 422, { error: "Ce fichier de sous-titres n'a pas pu être lu (formats acceptés : .srt et .vtt)." });
        }
      }

      let energy = null;
      try {
        energy = await getEnergy(uploadId, file);
      } catch (err) {
        if (err.code === 'FFMPEG_MISSING') throw err;
        if (!segments) return json(res, 422, { error: err.message });
      }

      if (segments) {
        const r = await analyzeSegments({ segments, videoId: null, targetSeconds: T, apiKey, model, energy, meta: { name: uploadNames.get(uploadId) || '' } });
        if (r.clips.length) {
          const clips = (energy ? refineClips(r.clips, energy) : r.clips).map((c) => relabel(c, null));
          const captionKey = `file:${uploadId}`;
          setSegments(captionKey, segments);
          return json(res, 200, {
            videoId: null,
            uploadId,
            captionKey,
            mode: r.mode,
            hasTranscript: true,
            totalSeconds: Math.round(info.duration),
            summary: r.summary || 'Analyse à partir des sous-titres fournis.',
            clips,
          });
        }
        if (!energy) return json(res, 422, { error: 'Les sous-titres sont trop courts pour proposer des extraits.' });
        // Texte insuffisant : on retombe sur l'analyse du son (les sous-titres restent utilisables pour l'incrustation).
        setSegments(`file:${uploadId}`, segments);
      }

      const raw = clipsFromAudio(energy, info.duration, T).map((c, i) => ({ ...c, title: `Moment fort ${i + 1}` }));
      const clips = finalizeClips(raw, {
        videoId: null,
        totalSeconds: info.duration,
        segments,
        minDur: Math.max(10, T * 0.35),
        meta: { name: uploadNames.get(uploadId) || '' },
      });
      json(res, 200, {
        videoId: null,
        uploadId,
        captionKey: segments ? `file:${uploadId}` : null,
        mode: 'audio',
        hasTranscript: Boolean(segments),
        totalSeconds: Math.round(info.duration),
        summary: segments
          ? "Les sous-titres sont trop courts pour juger le contenu : extraits choisis d'après le son (sous-titres incrustables)."
          : 'Analyse du son uniquement (pas de sous-titres) : résultats indicatifs, à vérifier en les regardant.',
        clips,
      });
    } catch (err) {
      fail(res, err);
    }
  }

  function history(req, res) {
    try {
      const items = fs
        .readdirSync(outputDir)
        .filter((f) => /^short-[a-z0-9-]+\.mp4$/.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(outputDir, f));
          return { name: f, url: '/clips/' + f, size: st.size, date: st.mtime.toISOString() };
        })
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 50);
      json(res, 200, { items });
    } catch (err) {
      fail(res, err);
    }
  }

  return { status, upload, cut, refine, analyzeFile, history, outputDir };
}
