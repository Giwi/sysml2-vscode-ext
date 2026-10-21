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
  await send('initialize', {
    processId: process.pid,
    rootUri: 'file://' + process.cwd(),
    capabilities: {},
    initializationOptions: { libraryPath: path.resolve('library'), libraryEnable: false },
  });
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

  const validation = await send('sysml/validate', { text: 'package P { part def A { }' });
  assert.ok((validation.result?.errors ?? []).length > 0, 'validate reports syntax errors');
  console.log('ok validate: syntax errors reported');

  proc.kill();
  console.log('LSP E2E PASSED');
}

main().catch((error) => {
  console.error(error);
  proc.kill();
  process.exit(1);
});
