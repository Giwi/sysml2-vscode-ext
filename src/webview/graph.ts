/* Renders the SysML structure as a block definition diagram (BDD) with a
 * purpose-built SVG renderer, and provides exploration: search, kind filter,
 * layout switching, zoom/pan/fit and selection details.
 *
 * Messages in:  { type: 'graph', data: GraphData | null }
 * Messages out: { command: 'ready' }
 *               { command: 'open', id }
 *               { command: 'export', format: 'png' | 'svg', data }
 *               { command: 'exportFailed', message }
 */
import type { GraphData, GraphNode } from '../shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// --- model types -----------------------------------------------------------

interface Compartment {
  title: string;
  rows: string[];
  more: number;
}

interface ModelNode {
  id: string;
  name: string;
  kind: string;
  type?: string;
  multiplicity?: string;
  depth: number;
  kids: ModelNode[];
  ports: ModelNode[];
  compartments: Compartment[];
  w: number;
  h: number;
  x: number;
  y: number;
  el: SVGGElement | null;
  visible?: boolean;
  /** Barycenter scratch value used during layout sweeps. */
  _bary?: number;
  /** Packed position used during layout passes. */
  _x?: number;
  _desired?: number;
}

interface ModelEdge {
  from: ModelNode;
  to: ModelNode;
  kind: string;
  label?: string;
  el?: SVGPathElement;
  labelEl?: SVGTextElement;
}

interface Point {
  x: number;
  y: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- palette ---------------------------------------------------------------

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
  'Requirement Definition': '#557a3f',
  RequirementDefinition: '#557a3f',
  Flow: '#4a7a8c',
  Connection: '#7a4a8c',
  Constraint: '#b07a3a',
  'Constraint Definition': '#c2955c',
};

const EDGE_COLORS: Record<string, string> = {
  contains: '#9aa0a6',
  typing: '#c25050',
  specializes: '#8a6bd8',
  subsets: '#3aa8a0',
  redefines: '#c07a3a',
  crosses: '#777d87',
  import: '#4f9a6e',
  dependency: '#777d87',
  alias: '#9aa0a6',
  connection: '#c58a3a',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// --- elements --------------------------------------------------------------

function byId<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id} in the graph webview`);
  }
  return element as unknown as T;
}

const statusEl = byId<HTMLElement>('status');
const layoutSelect = byId<HTMLSelectElement>('layout');
const searchInput = byId<HTMLInputElement>('search');
const kindSelect = byId<HTMLSelectElement>('kindFilter');
const detailsEl = byId<HTMLElement>('details');
const detailsName = byId<HTMLElement>('detailsName');
const detailsKind = byId<HTMLElement>('detailsKind');
const detailsMeta = byId<HTMLElement>('detailsMeta');

const svg = byId<SVGSVGElement>('graph');
const viewport = byId<SVGGElement>('viewport');
const edgeLayer = byId<SVGGElement>('edges');
const nodeLayer = byId<SVGGElement>('nodes');

// --- state -----------------------------------------------------------------

const model: {
  nodes: ModelNode[];
  edges: ModelEdge[];
  nodeById: Map<string, ModelNode>;
} = {
  nodes: [],
  edges: [],
  nodeById: new Map<string, ModelNode>(),
};

let currentLayout = 'tree';
let selectedId: string | null = null;
const view = { x: 0, y: 0, k: 1 };
let activeKind = '';
let searchTerm = '';
let hasRendered = false;

// Text metrics for compartment sizing.
const measureCtx = document.createElement('canvas').getContext('2d');
if (!measureCtx) {
  throw new Error('Canvas 2D context unavailable');
}
measureCtx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
const textWidth = (text: string): number => measureCtx.measureText(String(text)).width;

// --- helpers ---------------------------------------------------------------

function el(name: string, attrs?: Record<string, string | number | null | undefined>): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) {
        node.setAttribute(key, String(value));
      }
    }
  }
  return node;
}

function kindColor(kind: string): string {
  return KIND_COLORS[kind] || '#7f8792';
}

/** UML stereotype text for a SysML kind: `Part Definition` -> `part def`. */
function stereotype(kind: string): string {
  return String(kind)
    .replace(/ Definition$/, ' def')
    .replace(/Definition$/, 'def')
    .toLowerCase();
}

function compartmentOf(kind: string): string {
  if (/Requirement/.test(kind)) return 'requirements';
  if (/Attribute/.test(kind)) return 'attributes';
  if (/Port/.test(kind)) return 'ports';
  if (/Action/.test(kind)) return 'actions';
  if (/State/.test(kind)) return 'states';
  if (/Constraint/.test(kind)) return 'constraints';
  return 'parts';
}

const COMPARTMENT_TITLES: Record<string, string> = {
  parts: 'parts',
  attributes: 'attributes',
  ports: 'ports',
  actions: 'actions',
  states: 'states',
  requirements: 'requirements',
  constraints: 'constraints',
};

const MAX_ROWS = 6;

// --- model construction ----------------------------------------------------

function buildModel(data: GraphData): void {
  model.nodes = [];
  model.edges = [];
  model.nodeById = new Map<string, ModelNode>();

  const payloadById = new Map(data.nodes.map((node) => [node.id, node]));
  const kidsOf = new Map<string, string[]>();
  for (const edge of data.edges) {
    if (edge.kind !== 'contains' || !payloadById.has(edge.to)) {
      continue;
    }
    let list = kidsOf.get(edge.from);
    if (!list) {
      list = [];
      kidsOf.set(edge.from, list);
    }
    list.push(edge.to);
  }

  // Depths from the containment graph, not from the server hint, so filtering
  // and re-rooting stay consistent.
  const depths = new Map<string, number>();
  const roots: string[] = [];
  const hasParent = new Set<string>();
  for (const edge of data.edges) {
    if (edge.kind === 'contains') {
      hasParent.add(edge.to);
    }
  }
  for (const node of data.nodes) {
    if (!hasParent.has(node.id)) {
      roots.push(node.id);
    }
  }
  for (const root of roots) {
    depths.set(root, 0);
  }
  const assign = (id: string, depth: number): void => {
    for (const kid of kidsOf.get(id) || []) {
      if (!depths.has(kid)) {
        depths.set(kid, depth + 1);
        assign(kid, depth + 1);
      }
    }
  };
  for (const root of roots) {
    assign(root, 0);
  }
  for (const node of data.nodes) {
    if (!depths.has(node.id)) {
      depths.set(node.id, 0);
    }
  }

  for (const node of data.nodes) {
    const created: ModelNode = {
      id: node.id,
      name: node.label,
      kind: node.kind,
      type: node.type,
      multiplicity: node.multiplicity,
      depth: depths.get(node.id) || 0,
      kids: [],
      // Ports can be sent as decorations (IBD) or as contained symbols (BDD).
      ports: (node.ports ?? []).map((port) => ({
        id: `${node.id}:${port.name}`,
        name: port.name,
        kind: 'Port',
        type: port.type,
        depth: 0,
        kids: [],
        ports: [],
        compartments: [],
        w: 0,
        h: 0,
        x: 0,
        y: 0,
        el: null,
      })),
      compartments: [],
      w: 150,
      h: 40,
      x: 0,
      y: 0,
      el: null,
    };
    model.nodes.push(created);
    model.nodeById.set(created.id, created);
  }

  // Resolve containment to model nodes, preserving declaration order.
  for (const [from, kidIds] of kidsOf) {
    const parent = model.nodeById.get(from);
    if (!parent) {
      continue;
    }
    parent.kids = kidIds
      .map((id) => model.nodeById.get(id))
      .filter((node): node is ModelNode => node !== undefined);
  }

  for (const node of model.nodes) {
    sizeNode(node);
  }

  for (const edge of data.edges) {
    const from = model.nodeById.get(edge.from);
    const to = model.nodeById.get(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    model.edges.push({ from, to, kind: edge.kind, label: edge.label || undefined });
  }
}

/**
 * Row text in UML style: `name : Type [multiplicity]`.
 * Long names are clipped to keep blocks readable.
 */
function featureText(feature: ModelNode): string {
  let text = feature.name;
  if (feature.type) {
    text += ' : ' + feature.type;
  }
  if (feature.multiplicity) {
    text += ' [' + feature.multiplicity + ']';
  }
  return text;
}

/** Compute the block size from its header, ports and compartment rows. */
function sizeNode(node: ModelNode): void {
  // Ports are drawn on the block border, not as compartment rows.
  const kidPorts = node.kids.filter((kid) => /Port/.test(kid.kind));
  if (kidPorts.length) {
    node.ports = kidPorts;
  }

  const groups = new Map<string, ModelNode[]>();
  for (const kid of node.kids) {
    if (/Port/.test(kid.kind)) {
      continue;
    }
    const key = compartmentOf(kid.kind);
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    if (list.length < MAX_ROWS) {
      list.push(kid);
    }
  }
  node.compartments = [...groups.entries()].map(([key, items]) => ({
    title: COMPARTMENT_TITLES[key] || key,
    rows: items.map((kid) => clipText(featureText(kid), 250)),
    more: Math.max(
      0,
      node.kids.filter((kid) => !/Port/.test(kid.kind) && compartmentOf(kid.kind) === key).length -
        items.length
    ),
  }));

  let widest = Math.max(
    textWidth('\u00ab' + stereotype(node.kind) + '\u00bb'),
    textWidth(node.name)
  );
  for (const compartment of node.compartments) {
    for (const row of compartment.rows) {
      widest = Math.max(widest, textWidth(row) + 16);
    }
  }
  for (const port of node.ports) {
    widest = Math.max(widest, textWidth(clipText(featureText(port), 200)) + 34);
  }

  node.w = Math.round(Math.max(160, Math.min(300, widest + 26)));

  let height = 30; // stereotype + name
  let compartmentsHeight = 0;
  for (const compartment of node.compartments) {
    compartmentsHeight +=
      14 + compartment.rows.length * 13 + (compartment.more ? 11 : 0) + 6;
  }
  const portsHeight = node.ports.length ? node.ports.length * 16 + 10 : 0;
  height += Math.max(compartmentsHeight, portsHeight);
  node.h = Math.round(height + 10);
}

/** Clip a string to a pixel budget, with an ellipsis when shortened. */
function clipText(text: string, maxPx: number): string {
  if (textWidth(text) <= maxPx) {
    return text;
  }
  let out = text;
  while (out.length > 3 && textWidth(out + '\u2026') > maxPx) {
    out = out.slice(0, -1);
  }
  return out + '\u2026';
}

// --- rendering -------------------------------------------------------------

function render(data: GraphData | null): void {
  // A null payload means "no SysML document is available right now", for
  // example while the panel has focus and the active editor is undefined.
  // Keep whatever is already drawn instead of blanking the diagram.
  if (!data) {
    if (!hasRendered) {
      statusEl.textContent = 'Open a SysML file to see its structure';
    }
    return;
  }

  edgesClear();
  nodesClear();
  model.nodes = [];
  model.edges = [];
  model.nodeById = new Map<string, ModelNode>();
  selectedId = null;
  detailsEl.hidden = true;

  if (!data.nodes.length) {
    hasRendered = false;
    statusEl.textContent = 'No elements in this file';
    return;
  }

  hasRendered = true;
  buildModel(data);
  drawEdges();
  drawNodes();
  populateKindFilter(data.nodes);
  runLayout(currentLayout);
  applyFilters();
  updateStatus();
}

function clearChildren(layer: Element): void {
  while (layer.firstChild) {
    layer.removeChild(layer.firstChild);
  }
}

function edgesClear(): void {
  clearChildren(edgeLayer);
}

function nodesClear(): void {
  clearChildren(nodeLayer);
}

function drawNodes(): void {
  // One fragment for all blocks: avoids a reflow per appended node.
  const fragment = document.createDocumentFragment();
  for (const node of model.nodes) {
    const g = el('g', {
      class: 'node',
      'data-id': node.id,
      'data-kind': node.kind,
      transform: `translate(${node.x},${node.y})`,
    });

    const color = kindColor(node.kind);
    g.appendChild(
      el('rect', {
        x: -node.w / 2,
        y: -node.h / 2,
        width: node.w,
        height: node.h,
        rx: 3,
        class: 'block',
        fill: '#262b31',
        stroke: color,
        'stroke-width': 1.2,
      })
    );

    // Header: stereotype then name.
    const stereo = el('text', {
      x: 0,
      y: -node.h / 2 + 13,
      class: 'stereo',
      'text-anchor': 'middle',
      fill: color,
    });
    stereo.textContent = '\u00ab' + stereotype(node.kind) + '\u00bb';
    g.appendChild(stereo);

    const name = el('text', {
      x: 0,
      y: -node.h / 2 + 27,
      class: 'name',
      'text-anchor': 'middle',
      fill: '#e8ecf1',
    });
    name.textContent = node.name;
    g.appendChild(name);

    let y = -node.h / 2 + 34;

    // Ports sit on the left border as small squares, the UML convention.
    if (node.ports.length) {
      const top = y + 2;
      node.ports.forEach((port, index) => {
        const py = top + index * 16;
        g.appendChild(
          el('rect', {
            x: -node.w / 2 - 3.5,
            y: py - 3.5,
            width: 7,
            height: 7,
            class: 'port',
            fill: '#1e1e1e',
            stroke: color,
            'stroke-width': 1.4,
          })
        );
        const text = el('text', {
          x: -node.w / 2 + 8,
          y: py + 3.2,
          class: 'row port-label',
          fill: '#c9d1d9',
        });
        text.textContent = clipText(featureText(port), node.w - 24);
        g.appendChild(text);
      });
      y = top + node.ports.length * 16 + 4;
    }

    for (const compartment of node.compartments) {
      g.appendChild(
        el('line', {
          x1: -node.w / 2,
          y1: y,
          x2: node.w / 2,
          y2: y,
          class: 'separator',
          stroke: '#454d57',
          'stroke-width': 1,
        })
      );
      y += 13;

      const title = el('text', {
        x: -node.w / 2 + 8,
        y,
        class: 'compartment',
        fill: '#8b949e',
      });
      title.textContent = compartment.title;
      g.appendChild(title);
      y += 12;

      for (const row of compartment.rows) {
        g.appendChild(
          el('circle', {
            cx: -node.w / 2 + 9,
            cy: y - 3,
            r: 1.6,
            fill: '#6d7681',
          })
        );
        const text = el('text', {
          x: -node.w / 2 + 15,
          y,
          class: 'row',
          fill: '#c9d1d9',
        });
        text.textContent = row;
        g.appendChild(text);
        y += 13;
      }
      if (compartment.more) {
        const more = el('text', {
          x: -node.w / 2 + 15,
          y,
          class: 'row more',
          fill: '#7d8590',
        });
        more.textContent = '+' + compartment.more + ' more';
        g.appendChild(more);
        y += 11;
      }
    }

    node.el = g as SVGGElement;
    fragment.appendChild(g);

    g.addEventListener('click', (event: Event) => {
      event.stopPropagation();
      selectNode(node);
    });
    g.addEventListener('dblclick', (event: Event) => {
      event.stopPropagation();
      vscode.postMessage({ command: 'open', id: node.id });
    });
  }
  nodeLayer.appendChild(fragment);
}

function drawEdges(): void {
  // Build the whole edge layer off-DOM, then attach it once: one reflow
  // instead of one per relationship.
  const fragment = document.createDocumentFragment();
  for (const edge of model.edges) {
    const color = EDGE_COLORS[edge.kind] || '#7f8792';
    const dashed =
      edge.kind === 'dependency' || edge.kind === 'redefines' || edge.kind === 'crosses';
    const attrs: Record<string, string | number> = {
      class: 'edge edge-' + edge.kind,
      fill: 'none',
      stroke: color,
      'stroke-width': edge.kind === 'contains' ? 1.4 : 1.2,
      opacity: edge.kind === 'contains' ? 0.75 : 0.95,
    };
    const marker = markerFor(edge.kind);
    if (marker) {
      attrs['marker-end'] = marker;
    }
    if (dashed) {
      attrs['stroke-dasharray'] = '4 3';
    }
    if (edge.kind === 'contains') {
      // Composition: filled diamond on the owning (source) end.
      attrs['marker-start'] = 'url(#diamond)';
    }
    const path = el('path', attrs) as SVGPathElement;
    edge.el = path;
    fragment.appendChild(path);

    if (edge.label) {
      // Connector labels name the two ports: `power -> power`.
      const label = el('text', {
        class: 'edge-label',
        'text-anchor': 'middle',
        fill: '#b0b6bd',
      }) as SVGTextElement;
      label.textContent = edge.label;
      edge.labelEl = label;
      fragment.appendChild(label);
    }
  }
  edgeLayer.appendChild(fragment);
}

function markerFor(kind: string): string {
  switch (kind) {
    case 'contains':
    case 'connection':
      return '';
    case 'specializes':
    case 'subsets':
    case 'redefines':
      return 'url(#hollow-triangle)';
    case 'alias':
      return 'url(#dot-marker)';
    case 'crosses':
      return 'url(#circle-marker)';
    default:
      return 'url(#open-arrow)';
  }
}

/** Border point of a block along the direction to another point. */
function anchor(node: ModelNode, towardX: number, towardY: number): Point {
  const dx = towardX - node.x;
  const dy = towardY - node.y;
  const halfWidth = node.w / 2 + 1;
  const halfHeight = node.h / 2 + 1;
  const scale = Math.min(
    halfWidth / Math.abs(dx || 1e-6),
    halfHeight / Math.abs(dy || 1e-6)
  );
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

function applyPositions(): void {
  for (const node of model.nodes) {
    node.el?.setAttribute('transform', `translate(${node.x},${node.y})`);
  }
  for (const edge of model.edges) {
    if (!edge.el) {
      continue;
    }
    const start = anchor(edge.from, edge.to.x, edge.to.y);
    const end = anchor(edge.to, edge.from.x, edge.from.y);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    // Gentle curve so parallel relationship edges stay readable.
    const bend = edge.kind === 'contains' ? 0 : 0.12;
    const mx = (start.x + end.x) / 2 - dy * bend;
    const my = (start.y + end.y) / 2 + dx * bend;
    edge.el.setAttribute('d', `M ${start.x} ${start.y} Q ${mx} ${my} ${end.x} ${end.y}`);

    if (edge.labelEl) {
      // Quadratic midpoint: 0.25*start + 0.5*control + 0.25*end.
      const lx = 0.25 * start.x + 0.5 * mx + 0.25 * end.x;
      const ly = 0.25 * start.y + 0.5 * my + 0.25 * end.y;
      edge.labelEl.setAttribute('x', String(lx));
      edge.labelEl.setAttribute('y', String(ly - 5));
    }
  }
}

// --- layouts ---------------------------------------------------------------

/**
 * Layered (Sugiyama-style) layout for the containment hierarchy.
 *
 * 1. Assign each node to a layer by longest path from a root.
 * 2. Reduce crossings with barycenter sweeps using parent/child order.
 * 3. Pack each layer and align nodes towards their neighbours, resolving
 *    overlaps while keeping the order stable.
 */
function layoutTree(): void {
  const kids = new Map<string, ModelNode[]>();
  const parents = new Map<string, ModelNode[]>();
  const hasParent = new Set<string>();
  for (const edge of model.edges) {
    if (edge.kind !== 'contains') continue;
    let childList = kids.get(edge.from.id);
    if (!childList) {
      childList = [];
      kids.set(edge.from.id, childList);
    }
    childList.push(edge.to);
    let parentList = parents.get(edge.to.id);
    if (!parentList) {
      parentList = [];
      parents.set(edge.to.id, parentList);
    }
    parentList.push(edge.from);
    hasParent.add(edge.to.id);
  }

  const roots = model.nodes.filter((node) => !hasParent.has(node.id));
  const layerOf = new Map<string, number>();
  const queue = roots.map((node) => ({ node, depth: 0 }));
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    if ((layerOf.get(node.id) ?? -1) >= depth) {
      continue;
    }
    layerOf.set(node.id, depth);
    for (const kid of kids.get(node.id) || []) {
      queue.push({ node: kid, depth: depth + 1 });
    }
  }

  const layers: ModelNode[][] = [];
  for (const node of model.nodes) {
    const depth = layerOf.get(node.id) ?? 0;
    (layers[depth] ??= []).push(node);
  }
  // Drop empty layers left by filtered or orphaned nodes.
  const packed = layers.filter(Boolean);

  // Barycenter sweeps: alternate downward and upward.
  const position = (): Map<string, number> => {
    const map = new Map<string, number>();
    for (const layer of packed) {
      layer.forEach((node, index) => map.set(node.id, index));
    }
    return map;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    const downward = sweep % 2 === 0;
    const pos = position();
    const order = downward ? packed : [...packed].reverse();
    for (const layer of order) {
      for (const node of layer) {
        const neighbours = downward ? parents.get(node.id) : kids.get(node.id);
        if (neighbours && neighbours.length) {
          const sum = neighbours.reduce((acc, n) => acc + (pos.get(n.id) ?? 0), 0);
          node._bary = sum / neighbours.length;
        } else {
          node._bary = pos.get(node.id) ?? 0;
        }
      }
      layer.sort((a, b) => (a._bary ?? 0) - (b._bary ?? 0));
    }
  }

  const GAP_X = 38;
  const GAP_Y = 64;

  const packLayer = (layer: ModelNode[]): void => {
    if (!layer.length) return;
    let cursor = 0;
    for (const node of layer) {
      node._x = cursor + node.w / 2;
      cursor += node.w + GAP_X;
    }
    const center = layer.reduce((acc, n) => acc + (n._x ?? 0), 0) / layer.length;
    for (const node of layer) {
      node.x = (node._x ?? 0) - center;
    }
  };

  // Initial packing, then align towards parents.
  for (const layer of packed) {
    packLayer(layer);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let index = 1; index < packed.length; index++) {
      const layer = packed[index];
      for (const node of layer) {
        const ps = parents.get(node.id) || [];
        node._desired = ps.length
          ? ps.reduce((acc, p) => acc + p.x, 0) / ps.length
          : node.x;
      }
      layer.sort((a, b) => (a._desired ?? 0) - (b._desired ?? 0));
      let cursor = -Infinity;
      for (const node of layer) {
        const desired = node._desired ?? node.x;
        node.x = Math.max(desired, cursor + GAP_X + node.w / 2);
        cursor = node.x + node.w / 2;
      }
      // Re-center the layer to avoid drift across passes.
      const center = layer.reduce((acc, n) => acc + n.x, 0) / layer.length;
      for (const node of layer) node.x -= center;
    }
  }

  let y = 0;
  for (const layer of packed) {
    const height = Math.max(...layer.map((n) => n.h));
    for (const node of layer) {
      node.y = y + height / 2;
    }
    y += height + GAP_Y;
  }

  // Keep the whole diagram centered around the origin.
  const minX = Math.min(...model.nodes.map((n) => n.x - n.w / 2));
  const maxX = Math.max(...model.nodes.map((n) => n.x + n.w / 2));
  const shift = (minX + maxX) / 2;
  for (const node of model.nodes) node.x -= shift;
}

function layoutGrid(): void {
  const cols = Math.ceil(Math.sqrt(model.nodes.length));
  const maxW = Math.max(...model.nodes.map((n) => n.w));
  const maxH = Math.max(...model.nodes.map((n) => n.h));
  const gap = 26;
  model.nodes.forEach((node, index) => {
    node.x = (index % cols) * (maxW + gap);
    node.y = Math.floor(index / cols) * (maxH + gap);
  });
}

function layoutCircle(): void {
  const count = model.nodes.length;
  const maxDim = Math.max(...model.nodes.map((n) => Math.max(n.w, n.h)));
  const radius = Math.max(140, (count * (maxDim + 40)) / (2 * Math.PI));
  model.nodes.forEach((node, index) => {
    const angle = (index / count) * Math.PI * 2;
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  });
}

/**
 * Force-directed layout using a spatial hash for repulsion.
 *
 * A naive implementation compares every pair of nodes on every iteration,
 * which is 300^2 * 180 = 16 million operations on a large model. Bucketing
 * nodes into cells of roughly one ideal edge length reduces each iteration to
 * a handful of neighbours per node, so the layout stays interactive.
 */
function layoutForce(): void {
  const nodes = model.nodes;
  const maxW = Math.max(...nodes.map((n) => n.w)) + 80;
  const maxH = Math.max(...nodes.map((n) => n.h)) + 80;
  const cols = Math.ceil(Math.sqrt(nodes.length));

  // Seed on a regular grid so the simulation starts without overlaps.
  nodes.forEach((node, index) => {
    node.x = (index % cols) * maxW;
    node.y = Math.floor(index / cols) * maxH;
  });

  const links = model.edges.filter((edge) => edge.kind === 'contains');
  const ideal = Math.max(110, Math.max(maxW, maxH) * 0.9);
  const cellSize = ideal * 1.6;
  const iterations = 180;
  const disp = new Map<string, Point>(nodes.map((node) => [node.id, { x: 0, y: 0 }]));

  for (let step = 0; step < iterations; step++) {
    const temperature = 1 - step / iterations;
    for (const d of disp.values()) {
      d.x = 0;
      d.y = 0;
    }

    // Bucket nodes by cell for fast neighbour lookup.
    const buckets = new Map<string, ModelNode[]>();
    for (const node of nodes) {
      const key = Math.floor(node.x / cellSize) + ':' + Math.floor(node.y / cellSize);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(node);
    }

    // Repulsion, restricted to the 3x3 neighbourhood of each cell.
    for (const node of nodes) {
      const cx = Math.floor(node.x / cellSize);
      const cy = Math.floor(node.y / cellSize);
      const d = disp.get(node.id)!;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = buckets.get(cx + ox + ':' + (cy + oy));
          if (!bucket) {
            continue;
          }
          for (const other of bucket) {
            if (other === node) {
              continue;
            }
            let dx = node.x - other.x;
            let dy = node.y - other.y;
            let dist = Math.hypot(dx, dy);
            if (dist < 0.01) {
              // Coincident nodes would divide by zero; nudge deterministically.
              dx = (other.id.length % 7) - 3 || 1;
              dy = (node.id.length % 5) - 2 || 1;
              dist = Math.hypot(dx, dy);
            }
            if (dist > cellSize * 2) {
              continue;
            }
            const force = (ideal * ideal) / dist;
            d.x += (dx / dist) * force;
            d.y += (dy / dist) * force;
          }
        }
      }
    }

    // Attraction along containment links.
    for (const link of links) {
      const a = disp.get(link.from.id)!;
      const b = disp.get(link.to.id)!;
      let dx = link.from.x - link.to.x;
      let dy = link.from.y - link.to.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / ideal;
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      a.x -= dx;
      a.y -= dy;
      b.x += dx;
      b.y += dy;
    }

    // Move by the displacement, capped by the current temperature.
    for (const node of nodes) {
      const d = disp.get(node.id)!;
      const len = Math.hypot(d.x, d.y) || 0.01;
      const limit = Math.min(len, 60 * temperature);
      node.x += (d.x / len) * limit;
      node.y += (d.y / len) * limit;
    }
  }
}

function runLayout(name: string): void {
  currentLayout = name;
  if (!model.nodes.length) {
    return;
  }
  switch (name) {
    case 'grid':
      layoutGrid();
      break;
    case 'circle':
      layoutCircle();
      break;
    case 'force':
      layoutForce();
      break;
    default:
      layoutTree();
  }
  applyPositions();
  applyFilters();
  scheduleFit();
}

// --- view transform --------------------------------------------------------

function applyView(): void {
  viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
}

function contentBox(): Box {
  if (!model.nodes.length) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const node of model.nodes) {
    x1 = Math.min(x1, node.x - node.w / 2);
    y1 = Math.min(y1, node.y - node.h / 2);
    x2 = Math.max(x2, node.x + node.w / 2);
    y2 = Math.max(y2, node.y + node.h / 2);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function fit(): void {
  const box = contentBox();
  const rect = svg.getBoundingClientRect();
  const width = rect.width || 800;
  const height = rect.height || 600;
  const pad = 40;
  const scale = Math.min((width - pad * 2) / box.w, (height - pad * 2) / box.h, 1.4);
  view.k = Math.max(0.05, scale);
  view.x = width / 2 - (box.x + box.w / 2) * view.k;
  view.y = height / 2 - (box.y + box.h / 2) * view.k;
  applyView();
}

function scheduleFit(): void {
  requestAnimationFrame(() => {
    fit();
    // A second pass handles the case where the panel was just shown and the
    // element still reports a zero size on the first frame.
    setTimeout(fit, 60);
  });
}

// --- filters and search ----------------------------------------------------

function applyFilters(): void {
  for (const node of model.nodes) {
    const kindOk = !activeKind || node.kind === activeKind;
    if (node.el) {
      node.el.style.display = kindOk ? '' : 'none';
    }
    node.visible = kindOk;
  }
  for (const edge of model.edges) {
    if (edge.el) {
      const shown = edge.from.visible !== false && edge.to.visible !== false;
      edge.el.style.display = shown ? '' : 'none';
    }
  }
  applySearch();
}

function applySearch(): void {
  if (!searchTerm) {
    for (const node of model.nodes) {
      node.el?.classList.remove('match', 'dim');
    }
    return;
  }
  let matches = 0;
  for (const node of model.nodes) {
    if (!node.el) continue;
    if (node.name.toLowerCase().includes(searchTerm)) {
      node.el.classList.add('match');
      node.el.classList.remove('dim');
      matches++;
    } else {
      node.el.classList.remove('match');
      node.el.classList.add('dim');
    }
  }
  statusEl.textContent = `${matches} match${matches === 1 ? '' : 'es'} for "${searchTerm}"`;
}

// --- selection -------------------------------------------------------------

function selectNode(node: ModelNode | null): void {
  for (const other of model.nodes) {
    other.el?.classList.toggle('selected', other === node);
  }
  if (!node) {
    selectedId = null;
    detailsEl.hidden = true;
    return;
  }
  selectedId = node.id;
  detailsName.textContent = node.name;
  detailsKind.textContent = node.kind;
  const relationships = model.edges.filter(
    (edge) => edge.kind !== 'contains' && (edge.from === node || edge.to === node)
  ).length;
  const parts: string[] = [];
  if (node.kids.length) {
    parts.push(`${node.kids.length} child${node.kids.length === 1 ? '' : 'ren'}`);
  }
  parts.push(`${relationships} relationship${relationships === 1 ? '' : 's'}`);
  detailsMeta.textContent = parts.join(', ');
  detailsEl.hidden = false;
}

// --- kind filter -----------------------------------------------------------

function populateKindFilter(nodes: GraphNode[]): void {
  const kinds = [...new Set(nodes.map((node) => node.kind))].sort();
  const previous = kindSelect.value;
  kindSelect.innerHTML = '<option value="">All kinds</option>';
  for (const kind of kinds) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    kindSelect.appendChild(option);
  }
  kindSelect.value = kinds.includes(previous) ? previous : '';
  activeKind = kindSelect.value;
}

function updateStatus(): void {
  const total = model.nodes.length;
  const visible = model.nodes.filter((node) => node.visible !== false).length;
  statusEl.textContent =
    visible === total ? `${total} blocks` : `${visible} of ${total} blocks`;
}

// --- export ----------------------------------------------------------------

function exportSvgText(): string {
  const box = contentBox();
  const pad = 20;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('width', String(Math.ceil(box.w + pad * 2)));
  clone.setAttribute('height', String(Math.ceil(box.h + pad * 2)));
  clone.setAttribute(
    'viewBox',
    `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`
  );
  const inner = clone.querySelector('#viewport');
  inner?.removeAttribute('transform');
  const background = el('rect', {
    x: box.x - pad,
    y: box.y - pad,
    width: box.w + pad * 2,
    height: box.h + pad * 2,
    fill: '#1e1e1e',
  });
  clone.insertBefore(background, clone.firstChild);
  const style = el('style');
  style.textContent = exportStyles();
  clone.insertBefore(style, clone.firstChild);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}

function exportStyles(): string {
  return `
    text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .stereo { font-size: 9px; }
    .name { font-size: 11px; font-weight: 600; }
    .compartment { font-size: 9px; font-style: italic; }
    .row { font-size: 10px; }
    .more { font-style: italic; }
    .edge-label { font-size: 9px; paint-order: stroke; stroke: #1e1e1e; stroke-width: 3px; }
    .selected .block { stroke: #ffffff; stroke-width: 2; }
  `;
}

function exportPng(scale: number): void {
  if (!model.nodes.length) {
    return;
  }
  const source = exportSvgText();
  const box = contentBox();
  const width = Math.ceil((box.w + 40) * scale);
  const height = Math.ceil((box.h + 40) * scale);
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
    }
    URL.revokeObjectURL(url);
    vscode.postMessage({ command: 'export', format: 'png', data: canvas.toDataURL('image/png') });
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    vscode.postMessage({ command: 'exportFailed', message: 'PNG export failed' });
  };
  image.src = url;
}

function exportSvg(): void {
  if (!model.nodes.length) {
    return;
  }
  vscode.postMessage({ command: 'export', format: 'svg', data: exportSvgText() });
}

// --- interaction -----------------------------------------------------------

svg.addEventListener('click', () => selectNode(null));

let dragging: { x: number; y: number; vx: number; vy: number } | null = null;

svg.addEventListener('pointerdown', (event: PointerEvent) => {
  if (event.button !== 0) return;
  // Never start a pan on a block: that would swallow the click.
  const target = event.target as Element | null;
  if (target?.closest('.node')) return;
  dragging = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
  svg.setPointerCapture(event.pointerId);
});

svg.addEventListener('pointermove', (event: PointerEvent) => {
  if (!dragging) return;
  view.x = dragging.vx + (event.clientX - dragging.x);
  view.y = dragging.vy + (event.clientY - dragging.y);
  applyView();
});

svg.addEventListener('pointerup', (event: PointerEvent) => {
  dragging = null;
  if (svg.hasPointerCapture(event.pointerId)) {
    svg.releasePointerCapture(event.pointerId);
  }
});

svg.addEventListener('pointercancel', () => {
  dragging = null;
});

svg.addEventListener(
  'wheel',
  (event: WheelEvent) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(mx, my, factor);
  },
  { passive: false }
);

byId<HTMLElement>('zoomIn').addEventListener('click', () => {
  const rect = svg.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, 1.2);
});

byId<HTMLElement>('zoomOut').addEventListener('click', () => {
  const rect = svg.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, 1 / 1.2);
});

function zoomAt(mx: number, my: number, factor: number): void {
  const next = Math.min(4, Math.max(0.05, view.k * factor));
  view.x = mx - ((mx - view.x) * next) / view.k;
  view.y = my - ((my - view.y) * next) / view.k;
  view.k = next;
  applyView();
}

byId<HTMLElement>('fit').addEventListener('click', fit);
byId<HTMLElement>('exportPng').addEventListener('click', () => exportPng(2));
byId<HTMLElement>('exportSvg').addEventListener('click', exportSvg);

byId<HTMLElement>('detailsOpen').addEventListener('click', () => {
  if (selectedId) {
    vscode.postMessage({ command: 'open', id: selectedId });
  }
});

byId<HTMLElement>('detailsClose').addEventListener('click', () => selectNode(null));

layoutSelect.addEventListener('change', () => runLayout(layoutSelect.value));
kindSelect.addEventListener('change', () => {
  activeKind = kindSelect.value;
  applyFilters();
  updateStatus();
});

let searchTimer: number | undefined;
searchInput.addEventListener('input', () => {
  if (searchTimer !== undefined) {
    window.clearTimeout(searchTimer);
  }
  searchTimer = window.setTimeout(() => {
    searchTerm = searchInput.value.trim().toLowerCase();
    applySearch();
    if (!searchTerm) {
      updateStatus();
    }
  }, 120);
});

window.addEventListener('resize', () => {
  if (model.nodes.length) {
    fit();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && model.nodes.length) {
    scheduleFit();
  }
});

window.addEventListener('message', (event: MessageEvent) => {
  const payload = event.data as { type?: string; data?: GraphData | null } | undefined;
  if (payload?.type === 'graph') {
    render(payload.data ?? null);
    // The panel may still be zero-sized when the first message arrives, so fit
    // again once the layout has settled.
    scheduleFit();
  }
});

applyView();
vscode.postMessage({ command: 'ready' });
