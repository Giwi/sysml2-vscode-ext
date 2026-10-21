import type { GraphData } from '../shared/protocol';

/** Fill colours per SysML kind, shared with the DOT export. */
const KIND_COLORS: Record<string, string> = {
  Package: '#4f9a6e',
  Namespace: '#4f9a6e',
  'Part Definition': '#3b7dd8',
  Part: '#6aa5e8',
  'Item Definition': '#8a6bd8',
  Item: '#ab90e8',
  'Attribute Definition': '#c07a3a',
  Attribute: '#d69b63',
  'Port Definition': '#b5567e',
  Port: '#cf80a1',
  'Interface Definition': '#3aa8a0',
  Interface: '#6cc5be',
  Enumeration: '#8f8f3f',
  'Enumeration Value': '#b3b36b',
  Action: '#c25050',
  'Action Definition': '#a63d3d',
  State: '#7a6f9e',
  'State Definition': '#61577f',
  Requirement: '#557a3f',
  Flow: '#4a7a8c',
  Connection: '#7a4a8c',
};

function colorFor(kind: string): string {
  return KIND_COLORS[kind] ?? '#777d87';
}

/**
 * Serialize a graph as Graphviz DOT.
 *
 * Containment is dotted, relationships carry their label and a UML-like
 * arrow head so the .dot file matches the on-screen diagram closely enough to
 * be useful in a document build.
 */
export function toDot(data: GraphData): string {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const esc = (text: string): string => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const lines: string[] = [
    'digraph sysml {',
    '  rankdir=TB;',
    '  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=10];',
  ];
  for (const node of data.nodes) {
    lines.push(
      `  "${esc(node.id)}" [label="${esc(node.label)}\\n(${esc(node.kind)})", fillcolor="${colorFor(node.kind)}", fontcolor="white"];`
    );
  }
  for (const edge of data.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      continue;
    }
    if (edge.kind === 'contains') {
      lines.push(`  "${esc(edge.from)}" -> "${esc(edge.to)}" [style=dotted, color="#9aa0a6"];`);
    } else {
      const arrow = edge.kind === 'specializes' ? 'empty' : 'vee';
      lines.push(
        `  "${esc(edge.from)}" -> "${esc(edge.to)}" [label="${esc(edge.label || edge.kind)}", arrowhead=${arrow}, color="#c25050"];`
      );
    }
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}
