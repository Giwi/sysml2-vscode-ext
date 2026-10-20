#!/usr/bin/env node
// Regenerates the TypeScript ANTLR4 parser from grammar/*.g4 using the
// vendored ANTLR tool jar (tools/antlr-4.13.2-complete.jar).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jar = path.join(root, 'tools', 'antlr-4.13.2-complete.jar');
const out = path.join(root, 'src', 'server', 'generated');

if (!existsSync(jar)) {
  console.error(`ANTLR jar not found: ${jar}`);
  process.exit(1);
}

const args = (file, extra = []) => [
  '-jar',
  jar,
  '-Xexact-output-dir',
  '-Dlanguage=TypeScript',
  '-o',
  out,
  ...extra,
  path.join(root, 'grammar', file),
];

execFileSync('java', args('SysMLv2Lexer.g4'), { stdio: 'inherit' });
execFileSync('java', args('SysMLv2Parser.g4', ['-lib', out]), { stdio: 'inherit' });
console.log('Parser generated in', out);
