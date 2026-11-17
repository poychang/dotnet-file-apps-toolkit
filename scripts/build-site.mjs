import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('out/site/', root);
mkdirSync(output, { recursive: true });
cpSync(new URL('docs/', root), output, { recursive: true });
mkdirSync(new URL('assets/', output), { recursive: true });
for (const name of ['icon.png', 'tagged-comments-preview-dark.png', 'tagged-comments-preview-light.png']) {
  cpSync(new URL(`images/${name}`, root), new URL(`assets/${name}`, output));
}
console.log(`Built static site: ${fileURLToPath(output)}`);
