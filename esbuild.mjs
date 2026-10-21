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

const webview = {
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  minify: production,
  entryPoints: ['src/webview/graph.ts'],
  outfile: 'media/graph.js',
  sourcemap: false,
  logLevel: 'info',
  absWorkingDir: root,
};

const smokeBuilds = [
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
  {
    ...common,
    entryPoints: ['scripts/unit-tests.ts'],
    outfile: 'dist/unit-tests.js',
  },
  {
    ...common,
    entryPoints: ['scripts/lsp-e2e.ts'],
    outfile: 'dist/lsp-e2e.js',
  },
];

const appBuilds = [
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

const builds = [...(smoke ? smokeBuilds : appBuilds), webview];

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching...');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
