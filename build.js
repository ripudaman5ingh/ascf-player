// Inlines decoder.js + ascf-player.js into one classic <script> file.
// Two files, one import between them — a bundler would be a dependency for a
// concat. Run: npm run build
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const strip = (s) => s
  .replace(/^import[^;]*;\n/gm, '')
  .replace(/^export \{[^}]*\}[^;]*;\n/gm, '')
  .replace(/^export default .*\n/gm, '')
  .replace(/^export (?=(async )?function|const|class|let)/gm, '');

const out = `/* ascf-player — bundled global build. Defines <ascf-player>. */
(function () {
${strip(readFileSync('src/decoder.js', 'utf8'))}
${strip(readFileSync('src/ascf-player.js', 'utf8'))}
globalThis.AscfPlayer = AscfPlayer;
globalThis.AscfDecoder = { openAscf, makeDecoder, parseHeader };
})();
`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/ascf-player.js', out);
console.log(`dist/ascf-player.js  ${(out.length / 1024).toFixed(1)} kB`);
