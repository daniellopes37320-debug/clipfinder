// Analyse d'une vidéo YouTube : transcription -> meilleurs moments.
// Partagé par le serveur (server.js) et le mode automatique (auto.js).
import { enhanceClips } from './titles.js';
import { findClipsSimple } from './heuristic.js';
import { topKeywords } from './keywords.js';
import { buildMetadata } from './meta.js';

export function extractVideoId(input = '') {
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12);
    if (u.hostname.endsWith('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    /* pas une URL */
  }
  return null;
}

export function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// Selon la version, offset/duration sont en secondes ou en millisecondes.
export function normalizeTranscript(raw) {
  const unitMs = median(raw.map((r) => Number(r.duration) || 0)) > 100;
  const k = unitMs ? 1 / 1000 : 1;
  return raw
    .map((r) => ({
      start: (Number(r.offset) || 0) * k,
      dur: (Number(r.duration) || 0) * k,
      text: String(r.text || '')
        .replace(/&amp;#39;|&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((r) => r.text);
}

// Récupère la transcription (sous-titres). Lève une erreur de code NO_TRANSCRIPT si elle est introuvable.
export async function fetchSegments(videoId) {
  let raw;
  try {
    const { YoutubeTranscript } = await import('youtube-transcript');
    raw = await YoutubeTranscript.fetchTranscript(videoId);
  } catch (e) {
    const x = new Error("Impossible de récupérer la transcription. La vidéo n'a peut-être pas de sous-titres, ou elle est privée.");
    x.code = 'NO_TRANSCRIPT';
    throw x;
  }
  if (!raw?.length) {
    const x = new Error('Cette vidéo ne contient aucune transcription.');
    x.code = 'NO_TRANSCRIPT';
    throw x;
  }
  return normalizeTranscript(raw);
}

// Regroupe en lignes d'environ 8 secondes pour alléger le prompt.
function buildTranscriptText(segments) {
  const lines = [];
  let cur = null;
  for (const seg of segments) {
    if (!cur) cur = { start: seg.start, text: seg.text };
    else cur.text += ' ' + seg.text;
    if (seg.start + seg.dur - cur.start >= 8) {
      lines.push(`[${Math.round(cur.start)}] ${cur.text}`);
      cur = null;
    }
  }
  if (cur) lines.push(`[${Math.round(cur.start)}] ${cur.text}`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `Tu es un expert en montage de contenus courts (YouTube Shorts, TikTok, Reels).
On te donne la transcription d'une vidéo YouTube, avec des repères [secondes].
Ta mission : repérer les meilleurs passages à extraire en clips verticaux.

Critères d'un bon clip :
- Une accroche forte dans les 3 premières secondes (question, affirmation choc, promesse, anecdote)
- Une idée ou une histoire complète qui se comprend sans le reste de la vidéo
- Une émotion, une surprise, un humour, un conseil concret ou une révélation
- Une fin nette (chute, conclusion), pas coupée au milieu d'une phrase
- Respecte la durée visée indiquée par l'utilisateur (jamais moins de 15 secondes, jamais plus de 90)

Réponds UNIQUEMENT avec du JSON valide, sans texte autour, au format :
{
  "video_summary": "résumé de la vidéo en une phrase",
  "clips": [
    {
      "start": <secondes, nombre>,
      "end": <secondes, nombre>,
      "score": <0 à 100, potentiel viral>,
      "title": "titre accrocheur pour le Short, 60 caractères max",
      "hook": "la phrase d'accroche d'ouverture du clip",
      "reason": "pourquoi ce moment fonctionne, en 1 à 2 phrases"
    }
  ]
}
Donne entre 3 et 6 clips, classés du meilleur au moins bon, sans chevauchement.
Écris les titres et explications dans la langue de la vidéo.`;

const CLAUDE_TIMEOUT_MS = 60_000;

async function askClaude({ apiKey, model, transcriptText, totalSeconds, targetSeconds }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `Durée totale de la vidéo : ${Math.round(totalSeconds)} secondes.\n` +
            `Durée visée pour chaque clip : environ ${targetSeconds} secondes.\n\nTranscription :\n${transcriptText}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API Claude ${res.status} : ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('Réponse inattendue du modèle.');
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    throw new Error('Réponse du modèle illisible (JSON invalide).');
  }
}

// Recalcule les champs d'affichage d'un extrait après un changement de début/fin.
export function relabel(clip, videoId) {
  const start = Math.max(0, Math.round(clip.start));
  const end = Math.max(start, Math.round(clip.end));
  return {
    ...clip,
    start,
    end,
    startLabel: fmt(start),
    endLabel: fmt(end),
    duration: end - start,
    link: videoId ? `https://youtu.be/${videoId}?t=${start}` : '',
  };
}

// Nettoie les extraits bruts (bornes, score) et ajoute mots-clés + description.
export function finalizeClips(rawClips, { videoId, totalSeconds, segments, minDur = 10, meta = {} }) {
  return (rawClips || [])
    .map((c, idx) => {
      const start = Math.max(0, Math.floor(Number(c.start) || 0));
      let end = Math.min(Math.ceil(totalSeconds), Math.ceil(Number(c.end) || 0));
      if (end - start > 90) end = start + 90;
      const text = segments
        ? segments.filter((s) => s.start >= start - 1 && s.start < end).map((s) => s.text).join(' ')
        : '';
      const tags = topKeywords(text, 4);
      const hook = String(c.hook || '');
      const generic = !c.title || /^moment fort/i.test(String(c.title));
      const md = buildMetadata({
        ...meta,
        link: videoId ? `https://youtu.be/${videoId}?t=${start}` : '',
        text,
        hook,
        part: idx + 1,
        title: generic ? '' : String(c.title),
      });
      return relabel(
        {
          start,
          end,
          score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))),
          title: md.title,
          titles: md.titles,
          hook,
          reason: String(c.reason || ''),
          audioScored: Boolean(c.audioScored),
          tags,
          description: md.description,
        },
        videoId,
      );
    })
    .filter((c) => c.end - c.start >= minDur)
    .sort((a, b) => b.score - a.score);
}

// Analyse complète à partir de la transcription déjà récupérée.
export async function analyzeSegments({ segments, videoId, targetSeconds = 40, apiKey, model, energy = null, meta = {}, titleAI = null }) {
  const last = segments[segments.length - 1];
  const totalSeconds = last.start + last.dur;
  const target = Math.min(90, Math.max(15, Number(targetSeconds) || 40));

  let transcriptText = buildTranscriptText(segments);
  if (transcriptText.length > 180000) transcriptText = transcriptText.slice(0, 180000);

  // Sans clé API : analyse simple et gratuite. Avec clé : analyse par Claude.
  let mode = apiKey ? 'ai' : 'simple';
  let notice = '';
  let result;
  if (apiKey) {
    try {
      result = await askClaude({ apiKey, model, transcriptText, totalSeconds, targetSeconds: target });
    } catch (e) {
      // Claude indisponible (réseau, quota, délai dépassé) : on bascule sur l'analyse gratuite au lieu d'échouer.
      console.warn('Analyse Claude impossible, repli sur l\'analyse simple :', e.message);
      mode = 'simple';
      notice = 'Analyse IA indisponible (' + (e.name === 'TimeoutError' ? 'délai dépassé' : e.message.slice(0, 120)) + ') : analyse simple utilisée.';
    }
  }
  if (!result) result = findClipsSimple(segments, totalSeconds, 5, target, energy);

  let clips = finalizeClips(result.clips, { videoId, totalSeconds, segments, minDur: Math.max(10, target * 0.35), meta });
  // Titres, descriptions et hashtags rédigés par l'IA gratuite (Gemini), si une clé est configurée.
  const ai = await enhanceClips(clips, { segments, videoTitle: meta.videoTitle, channel: meta.channel, name: meta.name, link: videoId, ai: titleAI });
  clips = ai.clips;
  if (ai.notice) notice = [notice, ai.notice].filter(Boolean).join(' ');

  return {
    mode,
    notice,
    totalSeconds,
    summary: String(result.video_summary || ''),
    clips,
  };
}
