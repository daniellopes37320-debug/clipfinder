import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { createCutHandlers } from './cut.js';
import { createPublisher } from './publish.js';
import { ffmpegAvailable } from './reframe.js';
import { createAuto } from './auto.js';
import { extractVideoId, fetchSegments, analyzeSegments } from './analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
// Le site n'est accessible que depuis cet ordinateur (important : il peut publier sur ta chaîne).
const HOST = '127.0.0.1';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const rawKey = (process.env.ANTHROPIC_API_KEY || '').trim();
const API_KEY = rawKey && !/x{4,}/i.test(rawKey) ? rawKey : ''; // ignore la clé d'exemple

const app = express();

// Refuse les requêtes qui ne sont pas adressées à localhost (protection contre les sites malveillants).
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).send('Accès refusé.');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Transcriptions gardées en mémoire : utilisées pour les sous-titres incrustés.
const transcripts = new Map();
function remember(videoId, segments) {
  transcripts.delete(videoId);
  transcripts.set(videoId, segments);
  while (transcripts.size > 20) transcripts.delete(transcripts.keys().next().value);
}

// Création des Shorts à partir d'un fichier vidéo local (découpe + cadrage 9:16 + sous-titres, ffmpeg)
const cutter = createCutHandlers({
  baseDir: __dirname,
  getSegments: (id) => transcripts.get(id),
  setSegments: remember,
  apiKey: API_KEY,
  model: MODEL,
});
const publisher = createPublisher({ baseDir: __dirname, outputDir: cutter.outputDir, port: PORT });

// Dépôt automatique : les vidéos glissées dans le dossier « inbox » donnent des Shorts « à valider » (jamais publiés seuls)
const auto = createAuto({
  baseDir: __dirname,
  outputDir: cutter.outputDir,
  inboxDir: path.join(__dirname, 'inbox'),
  apiKey: API_KEY,
  model: MODEL,
  intervalMs: 8000,
});
app.get('/api/queue', auto.list);
app.post('/api/queue/scan', auto.scanNow);
app.post('/api/queue/reject', auto.reject);
app.post('/api/queue/done', auto.done);
app.post('/api/queue/reframe', auto.reframe);
app.post('/api/queue/delete-source', auto.deleteSource);
app.get('/api/queue/source/:id', (req, res) => {
  const p = auto.sourcePath(req.params.id);
  if (!p) return res.status(404).end();
  res.sendFile(p, { dotfiles: 'allow' });
});

app.get('/api/status', async (req, res) => {
  res.json({ ffmpeg: await ffmpegAvailable(), ai: Boolean(API_KEY) });
});
app.post('/api/upload', cutter.upload);
app.post('/api/cut', cutter.cut);
app.post('/api/refine', cutter.refine);
app.post('/api/analyze-file', cutter.analyzeFile);
app.get('/api/history', cutter.history);
app.use('/clips', express.static(cutter.outputDir));

// Publication YouTube
app.get('/auth/google', publisher.authStart);
app.get('/oauth/callback', publisher.authCallback);
app.get('/api/youtube/status', publisher.status);
app.post('/api/youtube/disconnect', publisher.disconnect);
app.post('/api/publish', publisher.publish);

// Titre et chaîne de la vidéo YouTube (service public « oEmbed », sans clé) : sert à rédiger la description.
async function fetchVideoInfo(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const j = await r.json();
    return { videoTitle: String(j.title || ''), channel: String(j.author_name || '') };
  } catch {
    return {};
  }
}

// Analyse d'un lien YouTube : transcription -> meilleurs moments
app.post('/api/analyze', async (req, res) => {
  try {
    const videoId = extractVideoId(req.body?.url);
    if (!videoId) return res.status(400).json({ error: "Ce lien YouTube n'est pas valide." });

    const infoPromise = fetchVideoInfo(videoId);
    let segments;
    try {
      segments = await fetchSegments(videoId);
    } catch (e) {
      if (e.code === 'NO_TRANSCRIPT') {
        return res.status(422).json({
          error: e.message + ' Vous pouvez aussi analyser directement votre fichier vidéo (analyse du son).',
          noTranscript: true,
        });
      }
      throw e;
    }
    remember(videoId, segments);

    const r = await analyzeSegments({
      segments,
      videoId,
      targetSeconds: req.body?.target,
      apiKey: API_KEY,
      model: MODEL,
      meta: await infoPromise,
    });
    res.json({
      videoId,
      mode: r.mode,
      hasTranscript: true,
      totalSeconds: Math.round(r.totalSeconds),
      summary: r.summary,
      clips: r.clips,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Erreur inattendue.' });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`ClipFinder prêt sur http://localhost:${PORT}`);
  console.log(API_KEY ? 'Analyse par Claude (clé API détectée).' : 'Mode gratuit : analyse simple, sans IA (aucune clé requise).');
  console.log(publisher.configured ? 'Publication YouTube configurée.' : 'Publication YouTube non configurée (facultatif, voir le README).');
  auto.start();
  console.log(`Dépôt automatique : glissez vos vidéos dans ${auto.inboxDir}`);
  ffmpegAvailable().then((ok) => {
    if (!ok) console.log("⚠️  ffmpeg est introuvable : installez-le avec « winget install Gyan.FFmpeg » pour créer des Shorts.");
  });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Le port ${PORT} est déjà utilisé. Fermez l'autre fenêtre ClipFinder, ou lancez avec un autre port (PORT=3001).`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
