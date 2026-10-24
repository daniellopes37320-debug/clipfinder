// Supprime les anciens Shorts du dossier output/ (réglage facultatif KEEP_DAYS).
import fs from 'node:fs';
import path from 'node:path';

export function cleanOutput({ outputDir, days, now = Date.now() }) {
  if (!(days > 0)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(outputDir)) {
    if (!/^short-[a-z0-9-]+\.mp4$/.test(f)) continue;
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
