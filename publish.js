// Publication d'un Short sur ta chaîne YouTube, avec l'API officielle (OAuth + envoi "resumable").
//   GET  /auth/google               -> envoie vers la page de connexion Google
//   GET  /oauth/callback            -> Google revient ici ; on enregistre l'autorisation
//   GET  /api/youtube/status        -> configuré ? connecté ? sur quelle chaîne ?
//   POST /api/youtube/disconnect    -> oublie l'autorisation enregistrée
//   POST /api/publish               -> envoie un Short du dossier output/ sur YouTube
// Aucune dépendance : uniquement Node (fetch, http, https).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload', // envoyer des vidéos
  'https://www.googleapis.com/auth/youtube.readonly', // lire le nom de la chaîne (affiché sur le site)
].join(' ');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.end();
}

const FRIENDLY = {
  quotaExceeded: "Le quota quotidien de l'API YouTube est atteint. Réessayez demain (ou demandez une hausse de quota dans Google Cloud).",
  dailyLimitExceeded: "Le quota quotidien de l'API YouTube est atteint. Réessayez demain.",
  youtubeSignupRequired: "Ce compte Google n'a pas encore de chaîne YouTube.",
  uploadLimitExceeded: "La limite d'envois de cette chaîne est atteinte pour le moment.",
  insufficientPermissions: 'Autorisation insuffisante : déconnectez puis reconnectez la chaîne.',
  forbidden: 'YouTube a refusé la demande (autorisation insuffisante ?). Déconnectez puis reconnectez la chaîne.',
};

function googleError(status, bodyText) {
  let message = '';
  let reason = '';
  try {
    const j = JSON.parse(bodyText);
    message = j?.error?.message || (typeof j?.error === 'string' ? j.error_description || j.error : '');
    reason = j?.error?.errors?.[0]?.reason || '';
  } catch {
    message = String(bodyText || '').slice(0, 200);
  }
  const err = new Error(FRIENDLY[reason] || `YouTube a répondu ${status}${message ? ' : ' + message : '.'}`);
  err.status = status;
  err.reason = reason;
  return err;
}

// Envoie le fichier avec un Content-Length explicite (requis par l'envoi "resumable").
const API_TIMEOUT_MS = 30_000; // délai des appels Google (hors envoi du fichier)
const UPLOAD_IDLE_MS = 120_000; // l'envoi du fichier est abandonné s'il ne progresse plus pendant 2 minutes

function putFile(url, file, size) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method: 'PUT', headers: { 'content-length': size, 'content-type': 'video/mp4' } },
      (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => resolve({ status: r.statusCode, text: b }));
      },
    );
    req.on('error', reject);
    req.setTimeout(UPLOAD_IDLE_MS, () => req.destroy(new Error("L'envoi vers YouTube ne répond plus : réessayez.")));
    fs.createReadStream(file).on('error', (e) => req.destroy(e)).pipe(req);
  });
}

export function createPublisher({ baseDir, outputDir, port, env = process.env }) {
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  const configured = Boolean(clientId && clientSecret);
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const AUTH_URL = env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL = env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const UPLOAD_URL = env.YT_UPLOAD_URL || 'https://www.googleapis.com/upload/youtube/v3/videos';
  const CHANNEL_URL = env.YT_CHANNEL_URL || 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';
  const tokenFile = path.join(baseDir, 'youtube-token.json');
  const states = new Set();
  let channelCache = null; // { name, at }

  function loadTokens() {
    try {
      return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    } catch {
      return null;
    }
  }
  function saveTokens(t) {
    fs.writeFileSync(tokenFile, JSON.stringify(t), { mode: 0o600 });
  }

  async function tokenRequest(params) {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    const text = await r.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* réponse non JSON */
    }
    return { ok: r.ok, status: r.status, body, text };
  }

  async function accessToken() {
    const t = loadTokens();
    if (!t?.refresh_token) {
      const e = new Error("La chaîne YouTube n'est pas connectée.");
      e.status = 401;
      throw e;
    }
    if (t.access_token && t.expires_at > Date.now() + 60_000) return t.access_token;
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    if (!r.ok) {
      if (r.body?.error === 'invalid_grant') {
        fs.rmSync(tokenFile, { force: true });
        const e = new Error('La connexion à YouTube a expiré : reconnectez la chaîne.');
        e.status = 401;
        throw e;
      }
      throw googleError(r.status, r.text);
    }
    saveTokens({ ...t, access_token: r.body.access_token, expires_at: Date.now() + (r.body.expires_in || 3600) * 1000 });
    return r.body.access_token;
  }

  async function channelName() {
    if (channelCache && Date.now() - channelCache.at < 10 * 60_000) return channelCache.name;
    const token = await accessToken();
    const r = await fetch(CHANNEL_URL, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!r.ok) return null;
    const j = await r.json();
    const name = j?.items?.[0]?.snippet?.title || null;
    channelCache = { name, at: Date.now() };
    return name;
  }

  async function status(req, res) {
    const connected = Boolean(loadTokens()?.refresh_token);
    let channel = null;
    if (configured && connected) {
      try {
        channel = await channelName();
      } catch {
        /* le nom est facultatif */
      }
    }
    json(res, 200, { configured, connected, channel, redirectUri });
  }

  function authStart(req, res) {
    if (!configured) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end("La publication YouTube n'est pas configurée : renseignez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans le fichier .env (voir le README).");
    }
    const state = randomBytes(16).toString('hex');
    states.add(state);
    setTimeout(() => states.delete(state), 10 * 60_000).unref?.();
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    redirect(res, `${AUTH_URL}?${q}`);
  }

  async function authCallback(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const back = (kind, msg = '') => redirect(res, `/?youtube=${kind}${msg ? '&msg=' + encodeURIComponent(msg) : ''}`);
    try {
      const state = u.searchParams.get('state');
      if (u.searchParams.get('error')) return back('error', 'Connexion refusée sur la page Google.');
      if (!state || !states.has(state)) return back('error', 'Session de connexion invalide, recommencez.');
      states.delete(state);
      const code = u.searchParams.get('code');
      if (!code) return back('error', 'Code de connexion manquant.');
      const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      if (!r.ok || !r.body.refresh_token) {
        return back('error', r.body?.error_description || r.body?.error || "Google n'a pas fourni d'autorisation durable, recommencez.");
      }
      saveTokens({
        refresh_token: r.body.refresh_token,
        access_token: r.body.access_token,
        expires_at: Date.now() + (r.body.expires_in || 3600) * 1000,
      });
      channelCache = null;
      back('connected');
    } catch (e) {
      console.error(e);
      back('error', e.message || 'Erreur inattendue.');
    }
  }

  function disconnect(req, res) {
    fs.rmSync(tokenFile, { force: true });
    channelCache = null;
    json(res, 200, { ok: true });
  }

  async function publish(req, res) {
    try {
      if (!configured) {
        return json(res, 400, { error: "La publication YouTube n'est pas configurée (voir le README)." });
      }
      const { name, title, description = '', privacy = 'private', rightsConfirmed = false } = req.body || {};
      if (rightsConfirmed !== true) return json(res, 400, { error: "Confirmez que vous avez le droit de publier cette vidéo (case « J'ai l'autorisation »)." });
      if (!/^short-[a-z0-9-]+\.mp4$/.test(String(name))) return json(res, 400, { error: 'Fichier inconnu.' });
      const file = path.join(outputDir, name);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'Ce Short est introuvable dans le dossier output.' });
      // YouTube refuse « < » et « > » dans le titre et la description (ex. les « >> » des sous-titres) : erreur invalidTitle/invalidDescription.
      const noAngle = (x) => String(x || '').replace(/[<>]/g, '');
      const t = noAngle(title).replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!t) return json(res, 400, { error: 'Le titre est obligatoire.' });
      const d = noAngle(description).slice(0, 4900);
      const priv = ['private', 'unlisted', 'public'].includes(privacy) ? privacy : 'private';

      const token = await accessToken();
      const size = fs.statSync(file).size;

      // 1) ouverture de la session d'envoi (titre, description, visibilité)
      const init = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
        method: 'POST',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(size),
          'x-upload-content-type': 'video/mp4',
        },
        body: JSON.stringify({
          snippet: { title: t, description: d, categoryId: '22' },
          status: { privacyStatus: priv, selfDeclaredMadeForKids: false },
        }),
      });
      if (!init.ok) throw googleError(init.status, await init.text());
      const sessionUrl = init.headers.get('location');
      if (!sessionUrl) throw new Error("Réponse inattendue de YouTube (pas d'adresse d'envoi).");

      // 2) envoi du fichier
      const up = await putFile(sessionUrl, file, size);
      if (up.status < 200 || up.status >= 300) throw googleError(up.status, up.text);
      let video = {};
      try {
        video = JSON.parse(up.text);
      } catch {
        /* réponse vide */
      }
      if (!video.id) throw new Error("YouTube n'a pas renvoyé l'identifiant de la vidéo.");
      json(res, 200, {
        id: video.id,
        url: `https://youtu.be/${video.id}`,
        privacy: video.status?.privacyStatus || priv,
        requested: priv,
      });
    } catch (e) {
      if (!e.status) console.error(e);
      const code = e.status === 401 ? 401 : e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded' ? 429 : 502;
      const msg = e.name === 'TimeoutError' ? 'Google ne répond pas : vérifiez votre connexion et réessayez.' : e.message;
      json(res, code, { error: msg || 'Erreur inattendue.' });
    }
  }

  return { status, authStart, authCallback, disconnect, publish, configured, redirectUri };
}
