/**
 * End-to-end test of the language server over stdio.
 *
 * Covers the custom payloads the extension depends on (graph, traceability,
 * validation) and the standard LSP features added for editing (formatting,
 * rename, code actions). Runs without VS Code, so it works in CI.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

interface RpcResponse {
  id?: number;
  result?: any;
  error?: { message: string };
}

const serverPath = path.resolve('dist/server.js');
const demo = path.resolve('examples/demo/demo.sysml');
const demoUri = 'file://' + demo;
const demoText = readFileSync(demo, 'utf8');

const proc = spawn(process.execPath, [serverPath, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = Buffer.alloc(0);
const pending = new Map<number, (body: RpcResponse) => void>();
let nextId = 1;

proc.stdout.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
    if (!match) return;
    const length = parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = JSON.parse(buffer.subarray(start, start + length).toString()) as RpcResponse;
    buffer = buffer.subarray(start + length);
    if (body.id != null && pending.has(body.id)) {
      pending.get(body.id)!(body);
      pending.delete(body.id);
    }
  }
});

function send(method: string, params: unknown): Promise<RpcResponse> {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method: string, params: unknown): void {
  const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}

function positionOf(text: string, needle: string) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `needle ${needle} exists`);
  const before = text.slice(0, index).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

async function main(): Promise<void> {
  const init = await send('initialize', {
    processId: process.pid,
    rootUri: 'file://' + process.cwd(),
    capabilities: {},
    initializationOptions: { libraryPath: path.resolve('library'), libraryEnable: false },
  });
  assert.equal(
    init.result?.capabilities?.documentFormattingProvider,
    true,
    'formatting capability is advertised, so editor.formatOnSave can call it'
  );
  notify('initialized', {});
  notify('textDocument/didOpen', {
    textDocument: { uri: demoUri, languageId: 'sysml', version: 1, text: demoText },
  });

  // Wait for the document to be indexed rather than sleeping a fixed time.
  for (let attempt = 0; attempt < 100; attempt++) {
    const symbols = await send('textDocument/documentSymbol', { textDocument: { uri: demoUri } });
    if ((symbols.result ?? []).length > 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const graph = await send('sysml/graph', { uri: demoUri, maxNodes: 300 });
  assert.ok(graph.result, 'graph payload exists');
  assert.equal(graph.result.nodes.length, 30, 'graph has 30 nodes');
  const wheel = graph.result.nodes.find((node: any) => node.label === 'wheel');
  assert.equal(wheel?.multiplicity, '4', 'multiplicity is serialised');
  assert.equal(wheel?.type, 'Wheel', 'type is serialised');
  console.log('ok graph:', graph.result.nodes.length, 'nodes, types and multiplicities');

  const trace = await send('sysml/traceability', {});
  assert.equal(trace.result.requirements.length, 1, 'one requirement');
  assert.equal(trace.result.verifications.length, 1, 'one verification case');
  assert.equal(trace.result.links.length, 1, 'one verify link');
  assert.equal(trace.result.requirements[0].name, 'VehicleRequirement');
  assert.equal(trace.result.verifications[0].name, 'MassVerification');
  console.log('ok traceability: 1 requirement, 1 verification, 1 link');

  const messy = 'package Demo {\n        part def A {\npart x : Real;\n    }\n}\n';
  const messyUri = 'file://' + path.resolve('/tmp/sysml-e2e-messy.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: messyUri, languageId: 'sysml', version: 1, text: messy },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const formatted = await send('textDocument/formatting', {
    textDocument: { uri: messyUri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(
    formatted.result?.[0]?.newText,
    'package Demo {\n  part def A {\n    part x : Real;\n  }\n}\n',
    'formatting output'
  );
  console.log('ok formatting');

  // Alignment is controlled by a setting pushed through didChangeConfiguration.
  notify('workspace/didChangeConfiguration', {
    settings: { sysml: { format: { alignMembers: true } } },
  });
  const alignedText = 'package A {\n  part a : A;\n  attribute longer : B;\n}\n';
  const alignedUri = 'file://' + path.resolve('/tmp/sysml-e2e-align.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: alignedUri, languageId: 'sysml', version: 1, text: alignedText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const aligned = await send('textDocument/formatting', {
    textDocument: { uri: alignedUri },
    options: { tabSize: 2, insertSpaces: true },
  });
  const alignedLines = String(aligned.result?.[0]?.newText ?? '').split('\n');
  assert.equal(
    alignedLines[1]?.indexOf(':'),
    alignedLines[2]?.indexOf(':'),
    'member separators are aligned'
  );
  console.log('ok formatting: members aligned');

  // Formatting twice must be a no-op: this is what format-on-save relies on.
  const formattedText = String(aligned.result?.[0]?.newText ?? alignedText);
  notify('textDocument/didChange', {
    textDocument: { uri: alignedUri, version: 2 },
    contentChanges: [{ text: formattedText }],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await send('textDocument/formatting', {
    textDocument: { uri: alignedUri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(second.result?.length ?? 0, 0, 'second format pass returns no edits');
  console.log('ok formatting: idempotent for format-on-save');

  const actions = await send('textDocument/codeAction', {
    textDocument: { uri: messyUri },
    range: { start: { line: 2, character: 10 }, end: { line: 2, character: 14 } },
    context: {
      diagnostics: [
        {
          range: { start: { line: 2, character: 10 }, end: { line: 2, character: 14 } },
          severity: 2,
          source: 'sysml',
          message: "Unresolved reference 'Real'",
        },
      ],
    },
  });
  const titles = (actions.result ?? []).map((action: any) => action.title);
  assert.ok(titles.includes('Import ScalarValues'), 'scalar import quick fix');
  console.log('ok code actions:', titles.join(', '));

  const rename = await send('textDocument/rename', {
    textDocument: { uri: demoUri },
    position: positionOf(demoText, 'VehicleRequirement'),
    newName: 'VehicleMassRequirement',
  });
  const edits = rename.result?.changes?.[demoUri] ?? [];
  assert.ok(edits.length >= 3, 'rename updates declaration and references');
  console.log('ok rename:', edits.length, 'edits');

  // Qualified references keep their qualifier; only the exact segment changes.
  const qualText = [
    'package Q {',
    '  part def Base {',
    '  }',
    '  part def Derived {',
    '  }',
    '  part b : Q::Base;',
    '}',
    '',
  ].join('\n');
  const qualUri = 'file://' + path.resolve('/tmp/sysml-e2e-qualified.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: qualUri, languageId: 'sysml', version: 1, text: qualText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const qualified = await send('textDocument/rename', {
    textDocument: { uri: qualUri },
    position: positionOf(qualText, 'Base'),
    newName: 'Root',
  });
  const qualifiedEdits = qualified.result?.changes?.[qualUri] ?? [];
  assert.equal(qualifiedEdits.length, 2, 'declaration and one qualified reference');
  const qualifiedRefEdit = qualifiedEdits.find((edit: any) => edit.range.start.line === 5);
  assert.ok(qualifiedRefEdit, 'qualified reference is edited');
  const refLine = qualText.split('\n')[5];
  const expectedCharacter = refLine.indexOf('Base');
  assert.equal(
    qualifiedRefEdit.range.start.character,
    expectedCharacter,
    'only the Base segment is replaced, not the whole Q::Base text'
  );
  assert.equal(
    qualifiedRefEdit.range.end.character,
    expectedCharacter + 'Base'.length,
    'segment range covers exactly Base'
  );
  console.log('ok rename qualified: segment-only replacement');

  // Renaming onto a sibling name must be refused instead of creating a duplicate.
  const duplicate = await send('textDocument/rename', {
    textDocument: { uri: qualUri },
    position: positionOf(qualText, 'Base'),
    newName: 'Derived',
  });
  assert.ok(duplicate.error, 'duplicate rename is rejected');
  assert.match(duplicate.error!.message, /already exists/, 'error explains the collision');
  console.log('ok rename collision: refused');

  const validation = await send('sysml/validate', { text: 'package P { part def A { }' });
  assert.ok((validation.result?.errors ?? []).length > 0, 'validate reports syntax errors');
  console.log('ok validate: syntax errors reported');

  // Code action: create a missing declaration.
  const missingText = 'package C {\n  part p : MissingType;\n}\n';
  const missingUri = 'file://' + path.resolve('/tmp/sysml-e2e-missing.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: missingUri, languageId: 'sysml', version: 1, text: missingText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const missingPos = positionOf(missingText, 'MissingType');
  const createActions = await send('textDocument/codeAction', {
    textDocument: { uri: missingUri },
    range: { start: missingPos, end: { line: missingPos.line, character: missingPos.character + 11 } },
    context: {
      diagnostics: [
        {
          range: { start: missingPos, end: { line: missingPos.line, character: missingPos.character + 11 } },
          severity: 2,
          source: 'sysml',
          message: "Unresolved reference 'MissingType'",
        },
      ],
    },
  });
  const createAction = (createActions.result ?? []).find((action: any) =>
    String(action.title).startsWith('Create part definition')
  );
  assert.ok(createAction, 'create missing declaration action');
  const createText = createAction.edit?.changes?.[missingUri]?.[0]?.newText ?? '';
  assert.match(createText, /part def MissingType/, 'declaration text');
  const createdLines = missingText.split('\n');
  createdLines.splice(1, 0, ...createText.split('\n'));
  const createdCheck = await send('sysml/validate', { text: createdLines.join('\n') });
  assert.equal((createdCheck.result?.errors ?? []).length, 0, 'created declaration parses');
  console.log('ok code action: create missing declaration');

  // Code action: extract a requirement from a comment.
  const commentText =
    'package R {\n  // The vehicle mass shall not exceed 2000 kg.\n  part def Body {\n  }\n}\n';
  const commentUri = 'file://' + path.resolve('/tmp/sysml-e2e-comment.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: commentUri, languageId: 'sysml', version: 1, text: commentText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const commentLine = 1;
  const extractActions = await send('textDocument/codeAction', {
    textDocument: { uri: commentUri },
    range: {
      start: { line: commentLine, character: 2 },
      end: { line: commentLine, character: 10 },
    },
    context: { diagnostics: [] },
  });
  const extractAction = (extractActions.result ?? []).find((action: any) =>
    String(action.title).startsWith('Extract requirement')
  );
  assert.ok(extractAction, 'extract requirement action');
  const extracted = extractAction.edit?.changes?.[commentUri]?.[0]?.newText ?? '';
  assert.match(extracted, /requirement def TheVehicleMassShallNot \{/, 'generated requirement name');
  assert.match(extracted, /doc \/\* The vehicle mass shall not exceed 2000 kg\. \*\//, 'comment preserved as doc');
  const extractedLines = commentText.split('\n');
  extractedLines.splice(commentLine + 1, 0, ...extracted.split('\n'));
  const extractedCheck = await send('sysml/validate', { text: extractedLines.join('\n') });
  assert.equal((extractedCheck.result?.errors ?? []).length, 0, 'extracted requirement parses');
  console.log('ok code action: extract requirement from comment');

  // Code action: create an allocation that satisfies a requirement.
  const reqText = 'package S {\n  requirement def BrakeRequirement {\n  }\n}\n';
  const reqUri = 'file://' + path.resolve('/tmp/sysml-e2e-satisfy.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: reqUri, languageId: 'sysml', version: 1, text: reqText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reqPos = positionOf(reqText, 'BrakeRequirement');
  const satisfyActions = await send('textDocument/codeAction', {
    textDocument: { uri: reqUri },
    range: { start: reqPos, end: { line: reqPos.line, character: reqPos.character + 16 } },
    context: { diagnostics: [] },
  });
  const satisfyAction = (satisfyActions.result ?? []).find((action: any) =>
    String(action.title).includes('allocation satisfying')
  );
  assert.ok(satisfyAction, 'satisfy allocation action');
  const allocation = satisfyAction.edit?.changes?.[reqUri]?.[0]?.newText ?? '';
  assert.match(allocation, /allocation def BrakeRequirementSatisfaction/, 'allocation name');
  assert.match(allocation, /satisfy BrakeRequirement;/, 'satisfy statement');
  const satisfyEdit = satisfyAction.edit?.changes?.[reqUri]?.[0];
  const satLines = reqText.split('\n');
  satLines.splice(satisfyEdit.range.start.line, 0, ...allocation.split('\n'));
  const satCheck = await send('sysml/validate', { text: satLines.join('\n') });
  assert.equal((satCheck.result?.errors ?? []).length, 0, 'satisfy allocation parses');
  console.log('ok code action: satisfy allocation');

  // Traceability exposes an insertion point that produces valid SysML.
  assert.ok(
    typeof trace.result.verifications[0].insertLine === 'number',
    'verification target has an insertion line'
  );
  const verifyLine = trace.result.verifications[0].insertLine;
  const verifyColumn = trace.result.verifications[0].insertCharacter ?? 0;
  const lines = demoText.split('\n');
  lines.splice(verifyLine, 0, ' '.repeat(verifyColumn) + 'verify VehicleRequirement;');
  const patched = lines.join('\n');
  const verifyValidation = await send('sysml/validate', { text: patched });
  assert.equal(
    (verifyValidation.result?.errors ?? []).length,
    0,
    'inserting verify at the reported position parses'
  );
  console.log('ok traceability: insertion point parses');

  // A verification case without an objective gets one when a link is added.
  const noObjText =
    'package T {\n  requirement def NoObjRequirement {\n  }\n  verification def NoObjVerification {\n  }\n}\n';
  const noObjUri = 'file://' + path.resolve('/tmp/sysml-e2e-no-objective.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: noObjUri, languageId: 'sysml', version: 1, text: noObjText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const traceWithNoObjective = await send('sysml/traceability', {});
  const noObjective = (traceWithNoObjective.result?.verifications ?? []).find(
    (item: any) => item.name === 'NoObjVerification'
  );
  assert.ok(noObjective, 'verification without objective is listed');
  assert.equal(noObjective.needsObjective, true, 'client is told to create an objective');
  const noObjLines = noObjText.split('\n');
  const noObjIndent = ' '.repeat(noObjective.insertCharacter ?? 0);
  noObjLines.splice(
    noObjective.insertLine,
    0,
    `${noObjIndent}objective {`,
    `${noObjIndent}  verify NoObjRequirement;`,
    `${noObjIndent}}`
  );
  const noObjCheck = await send('sysml/validate', { text: noObjLines.join('\n') });
  assert.equal(
    (noObjCheck.result?.errors ?? []).length,
    0,
    'generated objective block parses'
  );
  console.log('ok traceability: objective created when missing');

  // Semantic tokens: declarations and resolved references.
  const semantic = await send('textDocument/semanticTokens/full', {
    textDocument: { uri: demoUri },
  });
  const tokenData = semantic.result?.data ?? [];
  assert.ok(tokenData.length > 0, 'semantic tokens are produced');
  assert.equal(tokenData.length % 5, 0, 'tokens are 5-tuples');
  console.log('ok semantic tokens:', tokenData.length / 5, 'tokens');

  // Folding: braces become regions.
  const folding = await send('textDocument/foldingRange', { textDocument: { uri: demoUri } });
  assert.ok((folding.result ?? []).length > 0, 'folding ranges are produced');
  assert.ok(
    (folding.result ?? []).some((range: any) => range.kind === 'region'),
    'brace regions are folded'
  );
  console.log('ok folding:', (folding.result ?? []).length, 'ranges');

  // Inlay hints infer literal types.
  const hintText =
    'package H {\n  attribute mass = 12.5;\n  attribute count = 3;\n  attribute label = "x";\n}\n';
  const hintUri = 'file://' + path.resolve('/tmp/sysml-e2e-hints.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: hintUri, languageId: 'sysml', version: 1, text: hintText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hintValidation = await send('sysml/validate', { text: hintText });
  assert.equal((hintValidation.result?.errors ?? []).length, 0, 'inlay hint sample parses');
  const hints = await send('textDocument/inlayHint', {
    textDocument: { uri: hintUri },
    range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
  });
  const labels = (hints.result ?? []).map((hint: any) => hint.label);
  assert.ok(labels.includes(': Real'), 'real literal hint');
  assert.ok(labels.includes(': Integer'), 'integer literal hint');
  assert.ok(labels.includes(': String'), 'string literal hint');
  console.log('ok inlay hints:', labels.join(', '));

  // Signature help for a calc invocation.
  const calcText = [
    'package F {',
    '  calc def Mass {',
    '    in mass : Real;',
    '    in gravity : Real;',
    '    return : Real;',
    '  }',
    '  attribute weight = Mass(10, 9.81);',
    '}',
    '',
  ].join('\n');
  const calcUri = 'file://' + path.resolve('/tmp/sysml-e2e-signature.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: calcUri, languageId: 'sysml', version: 1, text: calcText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const calcValidation = await send('sysml/validate', { text: calcText });
  assert.equal((calcValidation.result?.errors ?? []).length, 0, 'calc invocation sample parses');
  const calcLines = calcText.split('\n');
  const callLineIndex = calcLines.findIndex((line) => line.includes('Mass(10,'));
  const callLine = calcLines[callLineIndex];
  const callPosition = {
    line: callLineIndex,
    character: callLine.indexOf('Mass(10,') + 'Mass(10,'.length,
  };
  const help = await send('textDocument/signatureHelp', {
    textDocument: { uri: calcUri },
    position: callPosition,
  });
  assert.ok(help.result, 'signature help is returned');
  const signature = help.result.signatures?.[0];
  assert.match(signature.label, /Mass\(in mass : Real, in gravity : Real, return : Real\)/);
  assert.equal(help.result.activeParameter, 1, 'cursor is on the second argument');
  console.log('ok signature help:', signature.label);

  // Internal block diagram: parts, ports and connectors.
  const ibdText = [
    'package P {',
    '  part def Engine {',
    '    port power : PowerPort;',
    '  }',
    '  part def Wheels {',
    '    port power : PowerPort;',
    '  }',
    '  part def Vehicle {',
    '    part engine : Engine;',
    '    part wheels : Wheels;',
    '    connect engine.power to wheels.power;',
    '  }',
    '}',
    '',
  ].join('\n');
  const ibdUri = 'file://' + path.resolve('/tmp/sysml-e2e-ibd.sysml');
  notify('textDocument/didOpen', {
    textDocument: { uri: ibdUri, languageId: 'sysml', version: 1, text: ibdText },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const ibdValidation = await send('sysml/validate', { text: ibdText });
  assert.equal((ibdValidation.result?.errors ?? []).length, 0, 'IBD sample parses');
  const vehicleLine = ibdText.split('\n').findIndex((line) => line.includes('part def Vehicle'));
  assert.ok(vehicleLine >= 0, 'Vehicle declaration found');
  const ibd = await send('sysml/ibd', { uri: ibdUri, line: vehicleLine, character: 2 });
  assert.ok(ibd.result, 'IBD payload exists');
  const ibdLabels = (ibd.result.nodes ?? []).map((node: any) => node.label);
  assert.equal(ibd.result.nodes[0]?.label, 'Vehicle', 'IBD is scoped to the part definition');
  assert.ok(ibdLabels.includes('Vehicle'), 'context is included');
  assert.ok(ibdLabels.includes('engine'), 'part engine is included');
  assert.ok(ibdLabels.includes('wheels'), 'part wheels is included');
  assert.ok(!ibdLabels.includes('power'), 'ports are decorations, not nodes');
  const engineNode = (ibd.result.nodes ?? []).find((node: any) => node.label === 'engine');
  assert.equal(engineNode?.ports?.[0]?.name, 'power', 'engine exposes its port');
  const connectionEdge = (ibd.result.edges ?? []).find(
    (edge: any) => edge.kind === 'connection'
  );
  assert.ok(connectionEdge, 'connector edge exists');
  assert.match(connectionEdge.label, /power/, 'connector names its ports');
  console.log('ok IBD:', ibd.result.nodes.length, 'nodes,', connectionEdge.label);

  proc.kill();
  console.log('LSP E2E PASSED');
}

main().catch((error) => {
  console.error(error);
  proc.kill();
  process.exit(1);
});
