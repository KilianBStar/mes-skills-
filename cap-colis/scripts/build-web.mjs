// Copie les fichiers de l'application web dans www/ (dossier embarqué dans l'app iOS).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const files = ['index.html', 'style.css', 'app.js', 'optimizer.js', 'scan.js', 'manifest.webmanifest', 'sw.js',
  'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of files) cpSync(join(root, f), join(out, f));
console.log(`www/ prêt (${files.length} fichiers)`);
