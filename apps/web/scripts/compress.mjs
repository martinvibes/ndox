// Writes brotli and gzip siblings for every text asset in dist, at maximum compression, so the
// server sends small files without compressing on each request (@fastify/static preCompressed).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const TEXT = /\.(js|css|html|svg|json|webmanifest|txt)$/;
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

let n = 0;
for (const file of walk(dist)) {
  if (!TEXT.test(file)) continue;
  const raw = readFileSync(file);
  if (raw.length < MIN_BYTES) continue;
  writeFileSync(
    `${file}.br`,
    brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
  );
  writeFileSync(`${file}.gz`, gzipSync(raw, { level: 9 }));
  n += 1;
}
console.log(`compressed ${n} files (br + gz)`);
