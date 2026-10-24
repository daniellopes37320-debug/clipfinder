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

// Enregistre des réglages dans le fichier .env (crée le fichier si besoin) et les applique tout de suite.
// updates : { CLE: 'valeur' } ; une valeur vide efface la ligne. Les autres lignes et commentaires sont conservés.
export function saveEnv(file, updates) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* premier enregistrement */
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Nom de réglage invalide.');
    if (/[\r\n\0]/.test(String(value))) throw new Error('Valeur invalide.');
    const re = new RegExp(`^\\s*${key}\\s*=`);
    const i = lines.findIndex((l) => re.test(l) && !l.trim().startsWith('#'));
    const line = `${key}=${value}`;
    if (i >= 0) lines[i] = line;
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(line);
    }
    if (value === '') delete process.env[key];
    else process.env[key] = String(value);
  }
  const out = lines.join(eol).replace(new RegExp(`(${eol})*$`), '') + eol;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
