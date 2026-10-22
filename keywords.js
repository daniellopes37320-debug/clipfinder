// Mots-clés et description d'un extrait (pour le titre, la description et les hashtags du Short).

const STOP = new Set(
  `alors aussi avoir avec cette comme dans donc elle elles entre être faire fait faut leur leurs mais même
  nous pour plus sans sont tout tous toute toutes très vous voilà ainsi après avant autre autres beaucoup chose
  choses encore enfin parce peut peuvent quand quel quelle quelques sous était étaient depuis déjà bien
  celui celle ceux cela ceci cest fois être ainsi alors voici voila dont comment pourquoi
  about after again because being could every first going great little might never other people really should
  still thing things think their there these they those through today want where which while would years right
  gonna yeah actually because maybe something someone anything everything`.split(/\s+/),
);

export function topKeywords(text, n = 4) {
  const counts = new Map();
  const plain = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' '); // [Music], (rires)…
  for (const raw of plain.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 5 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map(([w]) => w);
}

export function makeDescription({ hook = '', tags = [] }) {
  const hashtags = [...tags.map((t) => '#' + t), '#Shorts'].join(' ');
  return (hook ? hook.trim() + '\n\n' : '') + hashtags;
}
