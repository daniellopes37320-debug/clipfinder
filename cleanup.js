// Supprime les anciens Shorts du dossier output/ (réglage facultatif KEEP_DAYS).
// Les Shorts encore listés dans « À valider » (queue.json) ne sont jamais supprimés.
import fs from 'node:fs';
import path from 'node:path';

export function cleanOutput({ outputDir, stateFile, days, now = Date.now() }) {
  if (!(days > 0)) return 0;
  let keep = new Set();
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    keep = new Set((s.items || []).map((i) => i.name));
  } catch {
    /* pas de file d'attente : rien à protéger */
  }
  let removed = 0;
  for (const f of fs.readdirSync(outputDir)) {
    if (!/^short-[a-z0-9-]+\.mp4$/.test(f) || keep.has(f)) continue;
    try {
      const p = path.join(outputDir, f);
      if (now - fs.statSync(p).mtimeMs > days * 24 * 3600 * 1000) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch {
      /* on ignore */
    }
  }
  return removed;
}
