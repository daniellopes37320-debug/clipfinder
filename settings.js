// Réglages modifiables depuis l'onglet « Connexions » : clés IA, modèle, choix de l'IA des titres, identifiants Google.
// Tout est enregistré dans le fichier .env (jamais renvoyé en clair au navigateur : seulement un aperçu masqué).
import { saveEnv } from './env.js';
import { DEFAULT_GEMINI_MODEL } from './titles.js';

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
const KEY_RE = /^[A-Za-z0-9_\-.]{12,300}$/;
const MODEL_RE = /^[A-Za-z0-9_.\-:]{2,80}$/;
const GOOGLE_ID_RE = /^[A-Za-z0-9_\-.]{10,200}$/;
const TITLE_CHOICES = ['auto', 'gemini', 'claude', 'none'];

const val = (k) => (process.env[k] || '').trim();
const realKey = (v) => (v && !/x{4,}/i.test(v) ? v : ''); // ignore la clé d'exemple
const mask = (k) => (k ? (k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••') : '');

// Réglages actuels, relus à chaque appel : un changement dans l'onglet s'applique tout de suite.
export function currentConfig() {
  const gemini = val('GEMINI_API_KEY');
  const claude = realKey(val('ANTHROPIC_API_KEY'));
  const geminiModel = val('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
  const claudeModel = val('CLAUDE_MODEL') || DEFAULT_CLAUDE_MODEL;
  const pref = TITLE_CHOICES.includes(val('TITLE_AI')) ? val('TITLE_AI') : 'auto';
  const claudeMoments = val('CLAUDE_FOR_MOMENTS') === '1' && Boolean(claude);
  let provider = pref === 'auto' ? (gemini ? 'gemini' : claude ? 'claude' : 'none') : pref;
  if ((provider === 'gemini' && !gemini) || (provider === 'claude' && !claude)) provider = 'none';
  const titleAI =
    provider === 'gemini' ? { provider, apiKey: gemini, model: geminiModel } : provider === 'claude' ? { provider, apiKey: claude, model: claudeModel } : null;
  return { gemini, claude, geminiModel, claudeModel, pref, provider, claudeMoments, titleAI, momentsKey: claudeMoments ? claude : '' };
}

function clean(text, secrets) {
  let t = String(text || '').slice(0, 200);
  for (const s of secrets) if (s) t = t.split(s).join('•••');
  return t;
}

// Petit appel de vérification : la clé et le modèle répondent-ils ?
export async function testProvider(provider, { apiKey, model }) {
  if (!apiKey) return { ok: false, message: 'Aucune clé enregistrée.' };
  try {
    let res;
    if (provider === 'gemini') {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Réponds uniquement : OK' }] }], generationConfig: { maxOutputTokens: 20 } }),
      });
    } else {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'Réponds uniquement : OK' }] }),
      });
    }
    if (res.ok) return { ok: true, message: `Clé valide, modèle « ${model} » disponible.` };
    const body = await res.text();
    const why =
      res.status === 400 || res.status === 401 || res.status === 403
        ? 'Clé refusée : vérifie qu\'elle est complète, sans espace.'
        : res.status === 404
          ? `Modèle « ${model} » introuvable : change le nom du modèle.`
          : res.status === 429
            ? 'Quota atteint pour le moment : réessaie plus tard (la clé est valide).'
            : `Erreur ${res.status}.`;
    return { ok: false, message: `${why} (${clean(body, [apiKey]).replace(/\s+/g, ' ').slice(0, 120)})` };
  } catch (e) {
    return { ok: false, message: e.name === 'TimeoutError' ? 'Pas de réponse (délai dépassé) : vérifie ta connexion.' : 'Connexion impossible : ' + clean(e.message, [apiKey]) };
  }
}

export function createSettings({ envFile, port, onChange = () => {} }) {
  const json = (res, code, obj) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };

  function view() {
    const c = currentConfig();
    return {
      gemini: { set: Boolean(c.gemini), hint: mask(c.gemini), model: c.geminiModel, defaultModel: DEFAULT_GEMINI_MODEL },
      claude: { set: Boolean(c.claude), hint: mask(c.claude), model: c.claudeModel, moments: c.claudeMoments },
      titles: { pref: c.pref, provider: c.provider },
      google: { idSet: Boolean(val('GOOGLE_CLIENT_ID')), secretSet: Boolean(val('GOOGLE_CLIENT_SECRET')), idHint: mask(val('GOOGLE_CLIENT_ID')) },
      redirectUri: `http://localhost:${port}/oauth/callback`,
    };
  }

  function get(req, res) {
    json(res, 200, view());
  }

  function save(req, res) {
    try {
      const b = req.body || {};
      const up = {};
      const key = (field, env, re, label) => {
        if (b[field] === undefined || b[field] === null || String(b[field]).trim() === '') return;
        const v = String(b[field]).trim();
        if (!re.test(v)) throw new Error(`${label} : format invalide (vérifie qu'elle est complète, sans espace ni guillemets).`);
        up[env] = v;
      };
      key('geminiKey', 'GEMINI_API_KEY', KEY_RE, 'Clé Gemini');
      key('claudeKey', 'ANTHROPIC_API_KEY', KEY_RE, 'Clé Claude');
      key('googleId', 'GOOGLE_CLIENT_ID', GOOGLE_ID_RE, 'ID client Google');
      key('googleSecret', 'GOOGLE_CLIENT_SECRET', KEY_RE, 'Code secret Google');
      for (const [field, env] of [['geminiModel', 'GEMINI_MODEL'], ['claudeModel', 'CLAUDE_MODEL']]) {
        if (typeof b[field] === 'string') {
          const v = b[field].trim();
          if (v && !MODEL_RE.test(v)) throw new Error('Nom de modèle invalide.');
          up[env] = v;
        }
      }
      if (b.titleAI !== undefined) {
        if (!TITLE_CHOICES.includes(b.titleAI)) throw new Error('Choix invalide pour les titres.');
        up.TITLE_AI = b.titleAI;
      }
      if (b.claudeMoments !== undefined) up.CLAUDE_FOR_MOMENTS = b.claudeMoments ? '1' : '';
      const removable = { gemini: ['GEMINI_API_KEY'], claude: ['ANTHROPIC_API_KEY', 'CLAUDE_FOR_MOMENTS'], google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] };
      for (const r of Array.isArray(b.remove) ? b.remove : []) for (const k of removable[r] || []) up[k] = '';
      if (!Object.keys(up).length) return json(res, 200, { ok: true, settings: view() });
      saveEnv(envFile, up);
      onChange();
      json(res, 200, { ok: true, settings: view() });
    } catch (e) {
      json(res, 400, { error: e.message || 'Enregistrement impossible.' });
    }
  }

  async function test(req, res) {
    const provider = req.body?.provider === 'claude' ? 'claude' : req.body?.provider === 'gemini' ? 'gemini' : null;
    if (!provider) return json(res, 400, { error: 'IA inconnue.' });
    const c = currentConfig();
    const typed = String(req.body?.key || '').trim();
    const apiKey = typed || (provider === 'gemini' ? c.gemini : c.claude);
    if (typed && !KEY_RE.test(typed)) return json(res, 200, { ok: false, message: 'Format de clé invalide (complète, sans espace).' });
    const typedModel = String(req.body?.model || '').trim();
    const model = typedModel && MODEL_RE.test(typedModel) ? typedModel : provider === 'gemini' ? c.geminiModel : c.claudeModel;
    json(res, 200, await testProvider(provider, { apiKey, model }));
  }

  return { get, save, test, current: currentConfig };
}
