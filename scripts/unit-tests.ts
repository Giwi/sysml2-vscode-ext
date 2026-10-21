import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseText } from '../src/server/parser.js';
import { buildDocumentModel, flattenSymbols } from '../src/server/model.js';
import { extractCode } from '../src/ai/code.js';
import { formatText } from '../src/server/format.js';
import { foldingRanges, semanticTokens } from '../src/server/navigation.js';

const demo = readFileSync('examples/demo/demo.sysml', 'utf8');
const demoModel = buildDocumentModel('file:///demo.sysml', parseText(demo, false), false);
const symbols = flattenSymbols(demoModel);

test('format: re-indents by brace depth', () => {
  const input = 'package P {\n        part def A {\npart x : Real;\n    }\n}\n';
  const output = formatText(input, { insertSpaces: true, tabSize: 2 });
  assert.equal(output, 'package P {\n  part def A {\n    part x : Real;\n  }\n}\n');
});

test('format: ignores braces in strings and comments', () => {
  const input = 'package P {\npart s : String = "a } b"; // } comment\n/* } block */\n}\n';
  const output = formatText(input, { insertSpaces: true, tabSize: 2 });
  assert.match(output, /^package P \{\n  part s/m);
  assert.match(output, /a \} b/);
  assert.match(output, /\/\* \} block \*\//);
});

test('format: uses tabs when spaces are disabled', () => {
  const input = 'package P {\npart x : Real;\n}\n';
  const output = formatText(input, { insertSpaces: false, tabSize: 4 });
  assert.equal(output, 'package P {\n\tpart x : Real;\n}\n');
});

test('format: collapses blank-line runs and keeps a single trailing newline', () => {
  const input = 'package P {\n\n\n\npart x : Real;\n}\n\n\n';
  const output = formatText(input, { insertSpaces: true, tabSize: 2 });
  assert.equal(output, 'package P {\n\n  part x : Real;\n}\n');
});

test('model: extracts multiplicity and type', () => {
  const wheel = symbols.find((symbol) => symbol.name === 'wheel');
  assert.ok(wheel, 'wheel symbol exists');
  assert.equal(wheel.multiplicity, '4');
  assert.equal(wheel.refs.find((ref) => ref.kind === 'typing')?.text, 'Wheel');
});

test('model: records an explicit verify reference', () => {
  const verification = symbols.find((symbol) => symbol.name === 'MassVerification');
  assert.ok(verification, 'verification case exists');
  const verify = verification.refs.find((ref) => ref.kind === 'verify');
  assert.ok(verify, 'verify reference is explicit');
  assert.equal(verify.text, 'VehicleRequirement');
});

test('model: symbol kinds are specialised, not generic', () => {
  assert.equal(symbols.find((symbol) => symbol.name === 'Vehicle')?.kind, 'Part Definition');
  assert.equal(symbols.find((symbol) => symbol.name === 'VehicleRequirement')?.kind, 'Requirement Definition');
});

test('ai: extracts a fenced code block and falls back to plain text', () => {
  assert.equal(
    extractCode('Here you go:\n```sysml\npackage P {}\n```\nDone.', 'sysml'),
    'package P {}'
  );
  assert.equal(extractCode('package P {}', 'sysml'), 'package P {}');
});

test('format: aligns member separators when enabled', () => {
  const input = 'package P {\n  part a : A;\n  attribute longer : B;\n}\n';
  const output = formatText(input, { insertSpaces: true, tabSize: 2, alignMembers: true });
  const lines = output.split('\n');
  assert.equal(lines[1].indexOf(':'), lines[2].indexOf(':'), 'separators share a column');
});

test('format: alignment is disabled by default', () => {
  const input = 'package P {\n  part a : A;\n  attribute longer : B;\n}\n';
  const output = formatText(input, { insertSpaces: true, tabSize: 2 });
  assert.equal(output, input, 'no extra padding without the option');
});

test('format: alignment ignores :: qualifiers', () => {
  const input = 'package P {\n  part a : Q::A;\n  attribute longer : Q::B;\n}\n';
  const output = formatText(input, { insertSpaces: true, tabSize: 2, alignMembers: true });
  const lines = output.split('\n');
  assert.equal(lines[1].indexOf(':'), lines[2].indexOf(':'), 'typing colon is the anchor');
  assert.match(output, /Q::A/);
});

test('format: blank lines break alignment groups', () => {
  const input = 'package P {\n  part a : A;\n\n  attribute muchLonger : B;\n}\n';
  const output = formatText(input, { insertSpaces: true, tabSize: 2, alignMembers: true });
  const lines = output.split('\n');
  assert.notEqual(lines[1].indexOf(':'), lines[3].indexOf(':'), 'groups stay independent');
});

test('format: alignment is idempotent', () => {
  const input = 'package P {\n  part a : A;\n  attribute longer : B;\n}\n';
  const once = formatText(input, { insertSpaces: true, tabSize: 2, alignMembers: true });
  const twice = formatText(once, { insertSpaces: true, tabSize: 2, alignMembers: true });
  assert.equal(twice, once);
});

test('navigation: semantic tokens cover declarations', () => {
  const tokens = semanticTokens(demoModel);
  assert.ok(tokens.data.length > 0, 'tokens are produced');
  assert.equal(tokens.data.length % 5, 0, 'tokens are 5-tuples');
});

test('navigation: folds brace regions and comment blocks', () => {
  const ranges = foldingRanges('package P {\n  // first\n  // second\n  part p : P;\n}\n');
  assert.ok(ranges.some((range) => range.kind === 'region'), 'brace region');
  assert.ok(ranges.some((range) => range.kind === 'comment'), 'comment block');
});

test('model: extracts connect statements for the IBD', () => {
  const text = [
    'package P {',
    '  part def Vehicle {',
    '    part engine : Engine;',
    '    part wheels : Wheels;',
    '    connect engine.power to wheels.power;',
    '  }',
    '}',
    '',
  ].join('\n');
  const model = buildDocumentModel('file:///connect.sysml', parseText(text, false), false);
  assert.equal(model.connectors.length, 1, 'one connector');
  const connector = model.connectors[0];
  assert.equal(connector.from.owner, 'engine');
  assert.equal(connector.from.port, 'power');
  assert.equal(connector.to.owner, 'wheels');
  assert.equal(connector.to.port, 'power');
  assert.equal(connector.ownerQname, 'P::Vehicle');
});
