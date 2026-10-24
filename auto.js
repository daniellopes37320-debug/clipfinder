// Dépôt automatique : on glisse une vidéo (et, si on l'a, son .srt/.vtt du même nom) dans le dossier
// « inbox », et le site prépare tout seul les meilleurs Shorts. Ils attendent ensuite dans « À valider » :
// RIEN n'est jamais publié automatiquement, c'est toujours toi qui valides.
//
//   GET  /api/queue          -> Shorts à valider + état du dossier surveillé
//   POST /api/queue/scan     -> cherche tout de suite de nouvelles vidéos
//   POST /api/queue/reject   -> refuse un Short (le fichier est supprimé)
//   POST /api/queue/done     -> marque un Short comme publié (il quitte la liste)
//
// Limites : le cadrage est « suit l'action » (la détection de visages se fait dans le navigateur,
// donc seulement quand tu crées un Short toi-même depuis la page).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { probe, makeShort, sanitizeSamples, findLogo } from './reframe.js';
import { audioEnergy, refineClips, clipsFromAudio } from './audio.js';
import { analyzeSegments, finalizeClips, relabel } from './analysis.js';
import { buildAss, parseSubtitles } from './captions.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const SUB_EXT = ['.srt', '.vtt'];

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

const cutTitle = (t, n = 70) => (t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

const pretty = (base) =>
  base
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

export function createAuto({ baseDir, outputDir, inboxDir, apiKey = '', model = '', titleAI = null, perVideo = 3, intervalMs = 20000 }) {
  const stateFile = path.join(baseDir, 'queue.json');
  const tmpDir = path.join(baseDir, 'tmp');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  let state = { items: [], done: {} };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state = { items: Array.isArray(s.items) ? s.items : [], done: s.done && typeof s.done === 'object' ? s.done : {} };
  } catch {
    /* premier démarrage */
  }
  function save() {
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, stateFile);
  }

  const lastSizes = new Map(); // nom -> taille vue au passage précédent (un fichier en cours de copie grossit)
  let scanning = false;
  let current = null;
  let timer = null;
  const errors = []; // derniers échecs, affichés dans la page

  const keyOf = (name, st) => `${name}|${st.size}|${Math.round(st.mtimeMs)}`;

  function findSidecar(name) {
    const base = name.slice(0, name.length - path.extname(name).length).toLowerCase();
    const hit = fs.readdirSync(inboxDir).find((f) => {
      const ext = path.extname(f).toLowerCase();
      return SUB_EXT.includes(ext) && f.slice(0, f.length - ext.length).toLowerCase() === base;
    });
    return hit ? path.join(inboxDir, hit) : null;
  }

  async function processFile(name) {
    const file = path.join(inboxDir, name);
    const info = await probe(file);
    if (info.duration < 20) throw new Error('vidéo trop courte (moins de 20 secondes)');
    const base = name.slice(0, name.length - path.extname(name).length);

    let segments = null;
    const sidecar = findSidecar(name);
    if (sidecar) {
      const parsed = parseSubtitles(fs.readFileSync(sidecar, 'utf8'));
      if (parsed.length >= 3) segments = parsed;
    }

    let energy = null;
    try {
      energy = await audioEnergy(file);
    } catch (e) {
      if (!segments) throw new Error(e.message || 'pas de piste audio exploitable');
    }

    let clips = [];
    if (segments) {
      const r = await analyzeSegments({ segments, videoId: null, targetSeconds: 40, apiKey, model, energy, meta: { name }, titleAI });
      clips = energy ? refineClips(r.clips, energy).map((c) => relabel(c, null)) : r.clips;
    }
    if (!clips.length && energy) {
      const raw = clipsFromAudio(energy, info.duration, 40);
      clips = finalizeClips(raw, { videoId: null, totalSeconds: info.duration, segments, minDur: 14, meta: { name } });
    }
    if (!clips.length) throw new Error("aucun passage intéressant trouvé");

    const batch = new Date().toISOString();
    let made = 0;
    for (const [rank, c] of clips.slice(0, perVideo).entries()) {
      const end = Math.min(c.end, info.duration);
      const assText = segments ? buildAss({ segments, start: c.start, end }) : null;
      const outName = `short-${randomBytes(3).toString('hex')}-${Math.round(c.start)}s-auto.mp4`;
      await makeShort({
        input: file,
        start: c.start,
        end,
        framing: 'auto',
        outPath: path.join(outputDir, outName),
        info,
        assText,
        workDir: tmpDir,
        logo: findLogo(baseDir),
      });
      state.items.push({
        id: randomBytes(4).toString('hex'),
        name: outName,
        url: '/clips/' + outName,
        title: c.title,
        titles: c.titles || [c.title],
        description: c.description && c.description.trim() !== '#Shorts' ? c.description : `${c.title}\n\n#Shorts`,
        start: c.start,
        end,
        score: c.score,
        source: name,
        captions: Boolean(assText),
        createdAt: batch,
        rank,
      });
      made++;
      save();
    }
    return made;
  }

  // Un passage : cherche les nouvelles vidéos et les traite une par une.
  // quick : après un clic sur « Chercher maintenant », on vérifie la taille 2 secondes plus tard
  // au lieu d'attendre le passage suivant.
  async function scan({ quick = false } = {}) {
    if (scanning) return { skipped: true };
    scanning = true;
    let processed = 0;
    try {
      let names = [];
      try {
        names = fs.readdirSync(inboxDir).filter((f) => !f.startsWith('.') && VIDEO_EXT.has(path.extname(f).toLowerCase()));
      } catch {
        return { processed: 0 };
      }
      for (const name of names) {
        let st;
        try {
          st = fs.statSync(path.join(inboxDir, name));
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const key = keyOf(name, st);
        if (state.done[key]) continue;
        // On attend que la taille ne bouge plus entre deux passages (copie ou synchronisation en cours).
        if (lastSizes.get(name) !== st.size) {
          lastSizes.set(name, st.size);
          if (!quick) continue;
          await new Promise((r) => setTimeout(r, 2000));
          let st2;
          try {
            st2 = fs.statSync(path.join(inboxDir, name));
          } catch {
            continue;
          }
          if (st2.size !== st.size) {
            lastSizes.set(name, st2.size);
            continue;
          }
        }
        current = name;
        try {
          const n = await processFile(name);
          state.done[key] = { at: new Date().toISOString(), shorts: n };
          processed++;
        } catch (e) {
          console.error(`[dépôt] ${name} :`, e.message);
          state.done[key] = { at: new Date().toISOString(), error: e.message };
          errors.unshift({ file: name, message: e.message, at: new Date().toISOString() });
          errors.length = Math.min(errors.length, 5);
        } finally {
          current = null;
          save();
        }
      }
    } finally {
      scanning = false;
    }
    return { processed };
  }

  function start() {
    if (timer) return;
    setTimeout(() => scan().catch((e) => console.error(e)), 3000).unref?.();
    timer = setInterval(() => scan().catch((e) => console.error(e)), intervalMs);
    timer.unref?.();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // ----- routes
  function list(req, res) {
    const items = state.items
      .filter((i) => fs.existsSync(path.join(outputDir, i.name)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.rank - b.rank);
    let sources = [];
    try {
      sources = fs
        .readdirSync(inboxDir)
        .filter((f) => !f.startsWith('.') && VIDEO_EXT.has(path.extname(f).toLowerCase()))
        .map((f) => ({ name: f, size: fs.statSync(path.join(inboxDir, f)).size, shorts: state.items.filter((i) => i.source === f).length }));
    } catch {
      /* dossier absent */
    }
    json(res, 200, { items, sources, inboxDir, scanning: Boolean(current), current, errors });
  }

  // Relance les fichiers qui avaient échoué (ex. ffmpeg manquant au premier essai).
  function retry(req, res) {
    let n = 0;
    for (const k of Object.keys(state.done)) {
      if (state.done[k]?.error) {
        delete state.done[k];
        n++;
      }
    }
    errors.length = 0;
    save();
    scan({ quick: true }).catch((e) => console.error(e));
    json(res, 200, { ok: true, retried: n });
  }

  function scanNow(req, res) {
    scan({ quick: true }).catch((e) => console.error(e));
    json(res, 200, { ok: true });
  }

  function remove(id) {
    const i = state.items.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [it] = state.items.splice(i, 1);
    save();
    return it;
  }

  function reject(req, res) {
    const id = String(req.body?.id || '');
    if (!/^[a-f0-9]{8}$/.test(id)) return json(res, 400, { error: 'Identifiant invalide.' });
    const it = remove(id);
    if (!it) return json(res, 404, { error: 'Short introuvable.' });
    if (/^short-[a-z0-9-]+\.mp4$/.test(it.name)) fs.rm(path.join(outputDir, it.name), { force: true }, () => {});
    json(res, 200, { ok: true });
  }

  function done(req, res) {
    const id = String(req.body?.id || '');
    if (!/^[a-f0-9]{8}$/.test(id)) return json(res, 400, { error: 'Identifiant invalide.' });
    if (!remove(id)) return json(res, 404, { error: 'Short introuvable.' });
    json(res, 200, { ok: true });
  }

  // Supprime une vidéo du dossier inbox (et ses sous-titres). Les Shorts déjà créés ne sont pas touchés.
  function deleteSource(req, res) {
    const name = String(req.body?.name || '');
    if (!name || name !== path.basename(name) || !VIDEO_EXT.has(path.extname(name).toLowerCase())) {
      return json(res, 400, { error: 'Nom de fichier invalide.' });
    }
    if (current === name) return json(res, 409, { error: 'Cette vidéo est en cours de traitement : réessaie dans un instant.' });
    const file = path.join(inboxDir, name);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'Vidéo introuvable dans inbox.' });
    try {
      const sidecar = findSidecar(name);
      fs.unlinkSync(file);
      if (sidecar) fs.rmSync(sidecar, { force: true });
      lastSizes.delete(name);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, { error: 'Suppression impossible : ' + (e.message || 'fichier utilisé par un autre programme ?') });
    }
  }

  // Chemin de la vidéo d'origine d'un Short (pour la détection de visage dans le navigateur).
  function sourcePath(id) {
    if (!/^[a-f0-9]{8}$/.test(String(id))) return null;
    const it = state.items.find((x) => x.id === id);
    if (!it || it.source !== path.basename(it.source)) return null;
    const p = path.join(inboxDir, it.source);
    return fs.existsSync(p) ? p : null;
  }

  // Refait un Short avec le cadrage « visage » (positions envoyées par le navigateur).
  async function reframe(req, res) {
    try {
      const id = String(req.body?.id || '');
      const file = sourcePath(id);
      if (!file) return json(res, 404, { error: "Vidéo d'origine introuvable dans le dossier inbox." });
      const it = state.items.find((x) => x.id === id);
      const samples = sanitizeSamples(req.body?.samples);
      if (samples.length < 3) return json(res, 400, { error: 'Détection du visage incomplète.' });
      const info = await probe(file);
      let assText = null;
      const sidecar = findSidecar(it.source);
      if (sidecar) {
        const segs = parseSubtitles(fs.readFileSync(sidecar, 'utf8'));
        if (segs.length >= 3) assText = buildAss({ segments: segs, start: it.start, end: it.end });
      }
      const outName = `short-${randomBytes(3).toString('hex')}-${Math.round(it.start)}s-face.mp4`;
      const r = await makeShort({
        input: file,
        start: it.start,
        end: it.end,
        framing: 'face',
        outPath: path.join(outputDir, outName),
        info,
        samples,
        assText,
        workDir: tmpDir,
        logo: findLogo(baseDir),
      });
      const old = it.name;
      it.name = outName;
      it.url = '/clips/' + outName;
      it.framing = r.framing;
      save();
      if (/^short-[a-z0-9-]+\.mp4$/.test(old)) fs.rm(path.join(outputDir, old), { force: true }, () => {});
      json(res, 200, { ok: true, framing: r.framing, note: r.note || '' });
    } catch (e) {
      console.error(e);
      json(res, 500, { error: e.message || 'Erreur inattendue.' });
    }
  }

  return { start, stop, scan, list, scanNow, retry, reject, done, reframe, deleteSource, sourcePath, inboxDir };
}
