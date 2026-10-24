import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { createCutHandlers } from './cut.js';
import { createPublisher } from './publish.js';
import { ffmpegAvailable } from './reframe.js';
import { createSettings } from './settings.js';
import { cleanOutput } from './cleanup.js';
import { extractVideoId, fetchSegments, analyzeSegments } from './analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '.env');
loadEnv(ENV_FILE);

const PORT = Number(process.env.PORT) || 3000;
// Le site n'est accessible que depuis cet ordinateur (important : il peut publier sur ta chaîne).
const HOST = '127.0.0.1';
const app = express();

// Refuse les requêtes qui ne sont pas adressées à localhost (protection contre les sites malveillants).
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).send('Accès refusé.');
  next();
});
// Refuse les requêtes d'écriture venant d'un autre site (protection CSRF) : seul le site ClipFinder lui-même peut agir.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).send('Requête refusée.');
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return res.status(403).send('Requête refusée.');
  }
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
  getAI: () => {
    const c = settings.current();
    return { apiKey: c.momentsKey, model: c.claudeModel, titleAI: c.titleAI };
  },
});
// Nettoyage facultatif : KEEP_DAYS=30 supprime les Shorts de plus de 30 jours .
const keepDays = Number(process.env.KEEP_DAYS) || 0;
if (keepDays > 0) {
  const n = cleanOutput({ outputDir: cutter.outputDir, days: keepDays });
  if (n) console.log(`Nettoyage : ${n} ancien(s) Short(s) supprimé(s) (plus de ${keepDays} jours).`);
}
// Le publieur est recréé quand les identifiants Google changent (onglet Connexions).
const makePublisher = () => createPublisher({ baseDir: __dirname, outputDir: cutter.outputDir, port: PORT });
let publisher = makePublisher();
const settings = createSettings({ envFile: ENV_FILE, port: PORT, onChange: () => { publisher = makePublisher(); } });
app.get('/api/settings', settings.get);
app.post('/api/settings', settings.save);
app.post('/api/settings/test', settings.test);

app.get('/api/status', async (req, res) => {
  const c = settings.current();
  res.json({ ffmpeg: await ffmpegAvailable(), ai: Boolean(c.momentsKey), titlesAI: c.provider !== 'none', titlesProvider: c.provider });
});
app.post('/api/upload', cutter.upload);
app.post('/api/cut', cutter.cut);
app.post('/api/refine', cutter.refine);
app.post('/api/analyze-file', cutter.analyzeFile);
app.get('/api/history', cutter.history);
app.use('/clips', express.static(cutter.outputDir));

// Publication YouTube
app.get('/auth/google', (req, res) => publisher.authStart(req, res));
app.get('/oauth/callback', (req, res) => publisher.authCallback(req, res));
app.get('/api/youtube/status', (req, res) => publisher.status(req, res));
app.post('/api/youtube/disconnect', (req, res) => publisher.disconnect(req, res));
app.post('/api/publish', (req, res) => publisher.publish(req, res));

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
    const cfg = settings.current();
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
      apiKey: cfg.momentsKey,
      model: cfg.claudeModel,
      meta: await infoPromise,
      titleAI: cfg.titleAI,
    });
    res.json({
      videoId,
      mode: r.mode,
      hasTranscript: true,
      totalSeconds: Math.round(r.totalSeconds),
      summary: r.summary,
      notice: r.notice || '',
      clips: r.clips,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Erreur inattendue.' });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`ClipFinder prêt sur http://localhost:${PORT}`);
  const c = settings.current();
  console.log(c.momentsKey ? 'Moments trouvés par Claude (clé API activée).' : 'Moments trouvés par analyse simple (gratuite).');
  console.log(c.titleAI ? `Titres par ${c.provider === 'gemini' ? 'Gemini (gratuit)' : 'Claude'} (${c.titleAI.model}).` : 'Titres simples (pour des titres par IA : onglet Connexions).');
  console.log(publisher.configured ? 'Publication YouTube configurée.' : 'Publication YouTube non configurée (onglet Connexions).');
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
