#!/usr/bin/env node
// Generates syntaxes/sysml.tmLanguage.json from the ANTLR lexer grammar so
// that highlighting stays in sync with the parser tokens.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lexer = readFileSync(path.join(root, 'grammar', 'SysMLv2Lexer.g4'), 'utf8');

const wordKeywords = [];
const symbolTokens = [];
for (const m of lexer.matchAll(/^([A-Z_][A-Z0-9_]*)\s*:\s*'((?:[^'\\]|\\.)*)'\s*(?:->\s*skip)?\s*;/gm)) {
  const [, token, literal] = m;
  if (/^[a-z][a-z0-9]*$/.test(literal)) {
    wordKeywords.push(literal);
  } else if (literal.length > 0) {
    symbolTokens.push(literal);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPattern = wordKeywords.sort((a, b) => b.length - a.length).map(escapeRe).join('|');

const tml = {
  name: 'SysML v2',
  scopeName: 'source.sysml',
  patterns: [
    { include: '#comments' },
    { include: '#strings' },
    { include: '#numbers' },
    { include: '#keywords' },
    { include: '#operators' },
    { include: '#identifier' },
  ],
  repository: {
    comments: {
      patterns: [
        { name: 'comment.block.sysml', begin: '/\\*', end: '\\*/' },
        { name: 'comment.line.double-slash.sysml', match: '//[^*\\n][^\\n]*' },
        { name: 'comment.line.double-slash.sysml', match: '//' },
      ],
    },
    strings: {
      patterns: [
        { name: 'string.quoted.double.sysml', begin: '"', end: '"', patterns: [{ match: '\\\\.', name: 'constant.character.escape.sysml' }] },
        { name: 'string.quoted.single.sysml', begin: "'", end: "'", patterns: [{ match: '\\\\.', name: 'constant.character.escape.sysml' }] },
      ],
    },
    numbers: {
      patterns: [
        { name: 'constant.numeric.real.sysml', match: '\\b[0-9]+\\.[0-9]+([eE][+-]?[0-9]+)?\\b|\\b[0-9]+[eE][+-]?[0-9]+\\b' },
        { name: 'constant.numeric.integer.sysml', match: '\\b[0-9]+\\b' },
      ],
    },
    keywords: {
      patterns: [{ name: 'keyword.control.sysml', match: `\\b(?:${wordPattern})\\b` }],
    },
    operators: {
      patterns: [{ name: 'keyword.operator.sysml', match: symbolTokens.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|') }],
    },
    identifier: {
      patterns: [{ name: 'variable.name.sysml', match: '\\b[a-zA-Z_][a-zA-Z0-9_]*\\b' }],
    },
  },
};

const outDir = path.join(root, 'syntaxes');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'sysml.tmLanguage.json'), JSON.stringify(tml, null, 2) + '\n');
console.log(`tmLanguage generated: ${wordKeywords.length} keywords, ${symbolTokens.length} operator tokens`);
