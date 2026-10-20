// Smoke test for snippets: renders every snippet body with its placeholders
// resolved to harmless dummy names and parses the result. Catches snippets that
// would generate syntactically invalid SysML.
import * as fs from 'node:fs';
import { parseText } from '../src/server/parser';

interface Snippet {
  prefix: string;
  body: string[];
  description?: string;
}

const snippets: Record<string, Snippet> = JSON.parse(fs.readFileSync('snippets/sysml.json', 'utf8'));

/** Replace ${n:label}, ${n}, $n and $0 tab stops with a deterministic dummy. */
function render(body: string[]): string {
  // VS Code snippets do not allow a raw `}` inside a placeholder, so match a
  // label greedily up to the final `}` on that line.
  return body
    .join('\n')
    .replace(/\$\{\d+:([^}]*)\}/g, (_m, label: string) => dummyFor(label))
    .replace(/\$\{\d+\}/g, 'Placeholder')
    .replace(/\$\d+/g, '');
}

function dummyFor(label: string): string {
  const cleaned = label.trim();
  if (!cleaned) {
    return 'Placeholder';
  }
  // Keep comment-style labels so they render as valid comment tokens.
  if (cleaned.startsWith('/*') && cleaned.endsWith('*/')) {
    return cleaned;
  }
  // A referenced type/name must be a valid identifier; keep it simple.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned) ? cleaned : 'Placeholder';
}

let failures = 0;
for (const [name, snippet] of Object.entries(snippets)) {
  const text = render(snippet.body);
  const { errors } = parseText(text);
  if (errors.length > 0) {
    failures++;
    console.log(`[FAIL] ${name} (prefix: ${snippet.prefix})`);
    console.log(text.replace(/^/gm, '      | '));
    for (const e of errors.slice(0, 3)) {
      console.log(`      ${e.line + 1}:${e.column + 1} ${e.message}`);
    }
  }
}

console.log(`${Object.keys(snippets).length - failures}/${Object.keys(snippets).length} snippets parse cleanly`);
if (failures > 0) {
  console.error(`SNIPPET SMOKE FAILED: ${failures} snippet(s) generate invalid SysML`);
  process.exit(1);
}
console.log('SNIPPET SMOKE PASSED');
