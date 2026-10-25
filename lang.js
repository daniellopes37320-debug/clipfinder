// Langue d'un texte (français, anglais, espagnol, portugais, allemand, italien) et textes des modèles de titres.
// Reconnaissance simple par mots courants : suffisante pour choisir la langue des titres et des descriptions.

const WORDS = {
  fr: "le les des est une pas que qui pour dans avec je tu nous vous mais donc très c'est ça j'ai il elle sont fait être aussi comme",
  en: "the and is are of that you for with this was have not they what just like it's i'm don't can will about from there their",
  es: 'el los las una es y por con para pero no se lo como más muy está tengo esto que del al',
  pt: 'os as um uma não com para mas se como mais está isso você ele ela dos das do da muito',
  de: 'der die das und ist nicht ich ein eine mit auf für den dem sie es wir aber auch noch',
  it: 'il gli un una è che di per con non ma come più del della sono questo anche molto',
};
const SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(/\s+/))]));

export const LANG_NAMES = { fr: 'français', en: 'anglais', es: 'espagnol', pt: 'portugais', de: 'allemand', it: 'italien' };

// Renvoie 'fr' | 'en' | 'es' | 'pt' | 'de' | 'it', ou null si le texte est trop court ou ambigu.
export function detectLang(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  if (tokens.length < 6) return null;
  const score = {};
  for (const [lang, set] of Object.entries(SETS)) score[lang] = tokens.reduce((n, t) => n + (set.has(t) ? 1 : 0), 0);
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] / tokens.length < 0.1) return null;
  if (second[1] > 0 && best[1] < second[1] * 1.3) return null;
  return best[0];
}

// Textes des modèles de titres et de descriptions, par langue.
export const STR = {
  fr: {
    best: 'Le meilleur moment', bestLow: 'le meilleur moment', part: 'partie', watch: 'À voir :', dontMiss: 'À ne pas manquer :', extract: 'extrait',
    tip: "l'astuce à retenir 💡", fromVideo: 'Extrait de', fromClip: 'Extrait du clip', full: 'Vidéo complète', sub: 'Abonne-toi pour ne rien rater',
    music: (a, t) => [`Le nouveau banger de ${a} 🔥`, `${a} – « ${t} » : le nouveau clip 🎬`, `Ce son de ${a} va tourner en boucle 🎧`],
    musicLine: (a, t) => `🔥 Le nouveau banger de ${a} : « ${t} »`,
    musicNoArtist: (n) => [`Nouveau clip : ${n} 🔥`, `Le nouveau banger : ${n} 🎧`, `${n} : vous connaissez ? 👀`], musicNoArtistLine: (n) => `🔥 Nouveau clip : ${n}`,
  },
  en: {
    best: 'The best moment', bestLow: 'the best moment', part: 'part', watch: 'Watch:', dontMiss: "Don't miss:", extract: 'clip',
    tip: 'the tip to remember 💡', fromVideo: 'Clip from', fromClip: 'Clip from the music video', full: 'Full video', sub: 'Subscribe so you never miss one',
    music: (a, t) => [`The new banger from ${a} 🔥`, `${a} – “${t}”: the new video 🎬`, `This ${a} track will be on repeat 🎧`],
    musicLine: (a, t) => `🔥 The new banger from ${a}: “${t}”`,
    musicNoArtist: (n) => [`New video: ${n} 🔥`, `The new banger: ${n} 🎧`, `${n}: do you know it? 👀`], musicNoArtistLine: (n) => `🔥 New video: ${n}`,
  },
  es: {
    best: 'El mejor momento', bestLow: 'el mejor momento', part: 'parte', watch: 'Mira:', dontMiss: 'No te lo pierdas:', extract: 'fragmento',
    tip: 'el truco que debes recordar 💡', fromVideo: 'Fragmento de', fromClip: 'Fragmento del videoclip', full: 'Vídeo completo', sub: 'Suscríbete para no perderte nada',
    music: (a, t) => [`El nuevo temazo de ${a} 🔥`, `${a} – «${t}»: el nuevo videoclip 🎬`, `Esta canción de ${a} no vas a dejar de ponerla 🎧`],
    musicLine: (a, t) => `🔥 El nuevo temazo de ${a}: «${t}»`,
    musicNoArtist: (n) => [`Nuevo videoclip: ${n} 🔥`, `El nuevo temazo: ${n} 🎧`, `${n}: ¿lo conoces? 👀`], musicNoArtistLine: (n) => `🔥 Nuevo videoclip: ${n}`,
  },
  pt: {
    best: 'O melhor momento', bestLow: 'o melhor momento', part: 'parte', watch: 'Veja:', dontMiss: 'Não perca:', extract: 'trecho',
    tip: 'a dica para guardar 💡', fromVideo: 'Trecho de', fromClip: 'Trecho do clipe', full: 'Vídeo completo', sub: 'Inscreva-se para não perder nada',
    music: (a, t) => [`O novo hit de ${a} 🔥`, `${a} – “${t}”: o novo clipe 🎬`, `Essa música de ${a} vai ficar no repeat 🎧`],
    musicLine: (a, t) => `🔥 O novo hit de ${a}: “${t}”`,
    musicNoArtist: (n) => [`Novo clipe: ${n} 🔥`, `O novo hit: ${n} 🎧`, `${n}: você conhece? 👀`], musicNoArtistLine: (n) => `🔥 Novo clipe: ${n}`,
  },
  de: {
    best: 'Der beste Moment', bestLow: 'der beste Moment', part: 'Teil', watch: 'Ansehen:', dontMiss: 'Nicht verpassen:', extract: 'Ausschnitt',
    tip: 'der Tipp zum Merken 💡', fromVideo: 'Ausschnitt aus', fromClip: 'Ausschnitt aus dem Musikvideo', full: 'Ganzes Video', sub: 'Abonniere, um nichts zu verpassen',
    music: (a, t) => [`Der neue Banger von ${a} 🔥`, `${a} – „${t}“: das neue Video 🎬`, `Dieser Song von ${a} läuft gleich in Dauerschleife 🎧`],
    musicLine: (a, t) => `🔥 Der neue Banger von ${a}: „${t}“`,
    musicNoArtist: (n) => [`Neues Video: ${n} 🔥`, `Der neue Banger: ${n} 🎧`, `${n}: kennst du das? 👀`], musicNoArtistLine: (n) => `🔥 Neues Video: ${n}`,
  },
  it: {
    best: 'Il momento migliore', bestLow: 'il momento migliore', part: 'parte', watch: 'Guarda:', dontMiss: 'Da non perdere:', extract: 'estratto',
    tip: 'il consiglio da ricordare 💡', fromVideo: 'Estratto da', fromClip: 'Estratto dal videoclip', full: 'Video completo', sub: 'Iscriviti per non perdere nulla',
    music: (a, t) => [`Il nuovo pezzo di ${a} 🔥`, `${a} – «${t}»: il nuovo video 🎬`, `Questa canzone di ${a} la riascolterai di continuo 🎧`],
    musicLine: (a, t) => `🔥 Il nuovo pezzo di ${a}: «${t}»`,
    musicNoArtist: (n) => [`Nuovo video: ${n} 🔥`, `Il nuovo pezzo: ${n} 🎧`, `${n}: lo conosci? 👀`], musicNoArtistLine: (n) => `🔥 Nuovo video: ${n}`,
  },
};
