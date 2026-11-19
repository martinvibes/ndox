// Bundles the server (and the @ndox/* workspace packages it imports) into dist/index.js.
// Third-party dependencies stay external and are installed in the runtime image.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@ndox/'));

await build({
  entryPoints: { index: 'src/index.ts', cli: 'src/cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external,
  banner: {
    js: "import { createRequire as __ndoxCreateRequire } from 'node:module'; const require = __ndoxCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
