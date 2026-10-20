import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const smoke = process.argv.includes('--smoke');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  absWorkingDir: root,
  // antlr4's ESM build uses import.meta, which breaks when bundled to CJS;
  // pin the CJS distribution explicitly.
  alias: { antlr4: path.join(root, 'node_modules', 'antlr4', 'dist', 'antlr4.node.cjs') },
};

const builds = smoke
  ? [
      {
        ...common,
        entryPoints: ['scripts/smoke-entry.ts'],
        outfile: 'dist/smoke.js',
      },
      {
        ...common,
        entryPoints: ['scripts/snippet-smoke.ts'],
        outfile: 'dist/snippet-smoke.js',
      },
    ]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        external: ['vscode'],
      },
      {
        ...common,
        entryPoints: ['src/server/server.ts'],
        outfile: 'dist/server.js',
      },
    ];

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching...');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
