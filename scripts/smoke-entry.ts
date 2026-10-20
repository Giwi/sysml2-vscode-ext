// Smoke test: parses the bundled examples and the standard library, builds
// document models and reports syntax/semantic statistics. Exits non-zero if
// any example file fails to parse.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseText } from '../src/server/parser';
import { buildDocumentModel, flattenSymbols } from '../src/server/model';
import { Workspace } from '../src/server/workspace';
import type { DocumentModel, SysmlSymbol } from '../src/server/model';

function findFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(full, out);
    } else if (/\.(sysml|kerml)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface Stats {
  file: string;
  syntaxErrors: number;
  symbols: number;
}

function statsFor(file: string, library: boolean): { stats: Stats; model: DocumentModel } {
  const text = fs.readFileSync(file, 'utf8');
  const uri = 'file://' + path.resolve(file);
  const parse = parseText(text);
  const model = buildDocumentModel(uri, parse, library);
  return { stats: { file, syntaxErrors: parse.errors.length, symbols: flattenSymbols(model).length }, model };
}

const exampleFiles = findFiles('examples');
const libraryFiles = findFiles('library');

console.log(`Parsing ${exampleFiles.length} example files...`);
const exampleModels: DocumentModel[] = [];
let failed = false;
for (const file of exampleFiles) {
  const { stats, model } = statsFor(file, false);
  exampleModels.push(model);
  const flag = stats.syntaxErrors > 0 ? 'FAIL' : 'ok';
  console.log(`  [${flag}] ${path.relative(process.cwd(), file)} — ${stats.symbols} symbols, ${stats.syntaxErrors} syntax errors`);
  if (stats.syntaxErrors > 0) {
    failed = true;
    const parse = parseText(fs.readFileSync(file, 'utf8'));
    for (const err of parse.errors.slice(0, 5)) {
      console.log(`      ${err.line + 1}:${err.column + 1} ${err.message}`);
    }
  }
}

console.log(`Parsing ${libraryFiles.length} standard library files...`);
const t0 = Date.now();
let librarySymbols = 0;
const workspace = new Workspace();
for (const file of libraryFiles) {
  const uri = 'file://' + path.resolve(file);
  const model = workspace.update(uri, parseText(fs.readFileSync(file, 'utf8'), true), true);
  model.errors = [];
  librarySymbols += flattenSymbols(model).length;
}
console.log(`  ${librarySymbols} library symbols indexed in ${Date.now() - t0} ms`);

for (const model of exampleModels) {
  workspace.add(model);
}
// Re-resolve now that both library and example files are indexed.
for (const model of exampleModels) {
  workspace.resolveRefs(model);
}

// Cross-file resolution sanity check: every example typing reference into the
// library (e.g. ScalarValues::Real) must resolve.
let resolved = 0;
let unresolved = 0;
const unresolvedNames = new Set<string>();
for (const model of exampleModels) {
  const visit = (sym: SysmlSymbol): void => {
    for (const ref of sym.refs) {
      if (ref.kind === 'typing' || ref.kind === 'specializes') {
        const ok = ref.resolved !== undefined;
        if (ok) {
          resolved++;
        } else {
          unresolved++;
          unresolvedNames.add(ref.text);
        }
      }
    }
    for (const c of sym.children) {
      visit(c);
    }
  };
  visit(model.root);
}
console.log(`Example refs resolved: ${resolved}, unresolved: ${unresolved}`);
if (unresolved > 0) {
  console.log(`  unresolved names: ${[...unresolvedNames].slice(0, 20).join(', ')}`);
}

if (failed) {
  console.error('SMOKE TEST FAILED: syntax errors in example files');
  process.exit(1);
}
console.log('SMOKE TEST PASSED');
