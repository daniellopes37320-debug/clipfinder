// Lit le fichier .env (lignes CLE=valeur) sans dépendance. Les variables déjà définies dans le
// terminal gardent la priorité. Les lignes qui commencent par # sont ignorées.
import fs from 'node:fs';

export function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== '' && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
