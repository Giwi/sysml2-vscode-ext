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

const vscode = acquireVsCodeApi();

// --- palette ---------------------------------------------------------------

const KIND_COLORS = {
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
  'RequirementDefinition': '#557a3f',
  Flow: '#4a7a8c',
  Connection: '#7a4a8c',
  Constraint: '#b07a3a',
  'Constraint Definition': '#c2955c',
};

const EDGE_COLORS = {
  contains: '#9aa0a6',
  typing: '#c25050',
  specializes: '#8a6bd8',
  subsets: '#3aa8a0',
  redefines: '#c07a3a',
  crosses: '#777d87',
  import: '#4f9a6e',
  dependency: '#777d87',
  alias: '#9aa0a6',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// --- elements --------------------------------------------------------------

const statusEl = document.getElementById('status');
const layoutSelect = document.getElementById('layout');
const searchInput = document.getElementById('search');
const kindSelect = document.getElementById('kindFilter');
const detailsEl = document.getElementById('details');
const detailsName = document.getElementById('detailsName');
const detailsKind = document.getElementById('detailsKind');
const detailsMeta = document.getElementById('detailsMeta');

const svg = document.getElementById('graph');
const viewport = document.getElementById('viewport');
const edgeLayer = document.getElementById('edges');
const nodeLayer = document.getElementById('nodes');

// --- state -----------------------------------------------------------------

const model = {
  nodes: [], // { id, name, kind, kids, w, h, x, y, el }
  edges: [], // { from, to, kind, efrom, eto, el }
  nodeById: new Map(),
};

let currentLayout = 'tree';
let selectedId = null;
let view = { x: 0, y: 0, k: 1 };
let activeKind = '';
let searchTerm = '';
let hasRendered = false;

// Text metrics for compartment sizing.
const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
const textWidth = (s) => measureCtx.measureText(String(s)).width;

// --- helpers ---------------------------------------------------------------

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, String(value));
    }
  }
  return node;
}

function kindColor(kind) {
  return KIND_COLORS[kind] || '#7f8792';
}

/** UML stereotype text for a SysML kind: `Part Definition` -> `part def`. */
function stereotype(kind) {
  return String(kind)
    .replace(/ Definition$/, ' def')
    .replace(/Definition$/, 'def')
    .toLowerCase();
}

function compartmentOf(kind) {
  if (/Requirement/.test(kind)) return 'requirements';
  if (/Attribute/.test(kind)) return 'attributes';
  if (/Port/.test(kind)) return 'ports';
  if (/Action/.test(kind)) return 'actions';
  if (/State/.test(kind)) return 'states';
  if (/Constraint/.test(kind)) return 'constraints';
  return 'parts';
}

const COMPARTMENT_TITLES = {
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

function buildModel(data) {
  model.nodes = [];
  model.edges = [];
  model.nodeById = new Map();

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const kidsOf = new Map();
  for (const edge of data.edges) {
    if (edge.kind !== 'contains' || !byId.has(edge.to)) {
      continue;
    }
    if (!kidsOf.has(edge.from)) {
      kidsOf.set(edge.from, []);
    }
    kidsOf.get(edge.from).push(edge.to);
  }

  // Depths from the containment graph, not from the server hint, so filtering
  // and re-rooting stay consistent.
  const depths = new Map();
  const roots = [];
  const hasParent = new Set();
  for (const edge of data.edges) {
    if (edge.kind === 'contains') {
      hasParent.add(edge.to);
    }
  }
  for (const n of data.nodes) {
    if (!hasParent.has(n.id)) {
      roots.push(n.id);
    }
  }
  for (const root of roots) {
    depths.set(root, 0);
  }
  const assign = (id, depth) => {
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
  for (const n of data.nodes) {
    if (!depths.has(n.id)) {
      depths.set(n.id, 0);
    }
  }

  for (const n of data.nodes) {
    const node = {
      id: n.id,
      name: n.label,
      kind: n.kind,
      depth: depths.get(n.id) || 0,
      kids: [],
      w: 150,
      h: 40,
      x: 0,
      y: 0,
      el: null,
    };
    model.nodes.push(node);
    model.nodeById.set(node.id, node);
  }

  // Resolve containment to model nodes, preserving declaration order.
  for (const [from, kidIds] of kidsOf) {
    const parent = model.nodeById.get(from);
    if (!parent) {
      continue;
    }
    parent.kids = kidIds.map((id) => model.nodeById.get(id)).filter(Boolean);
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
    model.edges.push({ from, to, kind: edge.kind });
  }
}

/** Compute the block size from its header and compartment rows. */
function sizeNode(node) {
  const groups = new Map();
  for (const kid of node.kids) {
    const key = compartmentOf(kid.kind);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    if (groups.get(key).length < MAX_ROWS) {
      groups.get(key).push(kid);
    }
  }
  node.compartments = [...groups.entries()].map(([key, items]) => ({
    title: COMPARTMENT_TITLES[key] || key,
    rows: items.map((k) => k.name),
    more: Math.max(0, node.kids.filter((k) => compartmentOf(k.kind) === key).length - items.length),
  }));

  let widest = Math.max(textWidth('«' + stereotype(node.kind) + '»'), textWidth(node.name));
  for (const comp of node.compartments) {
    for (const row of comp.rows) {
      widest = Math.max(widest, textWidth(row) + 16);
    }
  }

  node.w = Math.round(Math.max(150, Math.min(280, widest + 26)));
  let h = 30; // stereotype + name
  for (const comp of node.compartments) {
    h += 14 + comp.rows.length * 13 + (comp.more ? 11 : 0) + 6;
  }
  node.h = Math.round(h + 8);
}

// --- rendering -------------------------------------------------------------

function render(data) {
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
  model.nodeById = new Map();
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

function clearChildren(layer) {
  while (layer.firstChild) {
    layer.removeChild(layer.firstChild);
  }
}

function edgesClear() {
  clearChildren(edgeLayer);
}

function nodesClear() {
  clearChildren(nodeLayer);
}

function drawNodes() {
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
    stereo.textContent = '«' + stereotype(node.kind) + '»';
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
    for (const comp of node.compartments) {
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
      title.textContent = comp.title;
      g.appendChild(title);
      y += 12;

      for (const row of comp.rows) {
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
      if (comp.more) {
        const more = el('text', {
          x: -node.w / 2 + 15,
          y,
          class: 'row more',
          fill: '#7d8590',
        });
        more.textContent = '+' + comp.more + ' more';
        g.appendChild(more);
        y += 11;
      }
    }

    node.el = g;
    fragment.appendChild(g);

    g.addEventListener('click', (evt) => {
      evt.stopPropagation();
      selectNode(node);
    });
    g.addEventListener('dblclick', (evt) => {
      evt.stopPropagation();
      vscode.postMessage({ command: 'open', id: node.id });
    });
  }
  nodeLayer.appendChild(fragment);
}

function drawEdges() {
  // Build the whole edge layer off-DOM, then attach it once: one reflow
  // instead of one per relationship.
  const fragment = document.createDocumentFragment();
  for (const edge of model.edges) {
    const color = EDGE_COLORS[edge.kind] || '#7f8792';
    const dashed =
      edge.kind === 'dependency' || edge.kind === 'redefines' || edge.kind === 'crosses';
    const attrs = {
      class: 'edge edge-' + edge.kind,
      fill: 'none',
      stroke: color,
      'stroke-width': edge.kind === 'contains' ? 1.4 : 1.2,
      'marker-end': markerFor(edge.kind),
      opacity: edge.kind === 'contains' ? 0.75 : 0.95,
    };
    if (dashed) {
      attrs['stroke-dasharray'] = '4 3';
    }
    if (edge.kind === 'contains') {
      // Composition: filled diamond on the owning (source) end.
      attrs['marker-start'] = 'url(#diamond)';
    }
    const path = el('path', attrs);
    edge.el = path;
    fragment.appendChild(path);
  }
  edgeLayer.appendChild(fragment);
}

function markerFor(kind) {
  switch (kind) {
    case 'specializes':
    case 'subsets':
    case 'redefines':
      return 'url(#hollow-triangle)';
    case 'typing':
      return 'url(#open-arrow)';
    case 'import':
    case 'dependency':
      return 'url(#open-arrow)';
    case 'alias':
      return 'url(#dot-marker)';
    case 'crosses':
      return 'url(#circle-marker)';
    default:
      return 'url(#open-arrow)';
  }
}

/** Border point of a block along the direction to another point. */
function anchor(node, towardX, towardY) {
  const dx = towardX - node.x;
  const dy = towardY - node.y;
  const hw = node.w / 2 + 1;
  const hh = node.h / 2 + 1;
  const scale = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

function applyPositions() {
  for (const node of model.nodes) {
    if (node.el) {
      node.el.setAttribute('transform', `translate(${node.x},${node.y})`);
    }
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
  }
}

// --- layouts ---------------------------------------------------------------

function layoutTree() {
  const kids = new Map();
  const hasParent = new Set();
  for (const edge of model.edges) {
    if (edge.kind !== 'contains') continue;
    if (!kids.has(edge.from.id)) kids.set(edge.from.id, []);
    kids.get(edge.from.id).push(edge.to);
    hasParent.add(edge.to.id);
  }
  const roots = model.nodes.filter((n) => !hasParent.has(n.id));
  const order = roots.length ? roots : model.nodes.slice(0, 1);

  const GAP_X = 34;
  const GAP_Y = 52;
  const levelHeight = [];
  for (const node of model.nodes) {
    levelHeight[node.depth] = Math.max(levelHeight[node.depth] || 0, node.h);
  }
  const levelY = [];
  let y = 0;
  for (let i = 0; i < levelHeight.length; i++) {
    levelY[i] = y + (levelHeight[i] || 0) / 2;
    y += (levelHeight[i] || 0) + GAP_Y;
  }

  const place = (node, left) => {
    const children = kids.get(node.id) || [];
    if (!children.length) {
      node.x = left + node.w / 2;
      return node.w;
    }
    let cursor = left;
    let total = 0;
    for (const kid of children) {
      const w = place(kid, cursor);
      cursor += w + GAP_X;
      total += w + GAP_X;
    }
    total -= GAP_X;
    const width = Math.max(node.w, total);
    node.x = left + width / 2;
    return width;
  };

  let cursor = 0;
  for (const root of order) {
    cursor += place(root, cursor) + GAP_X * 2;
  }
  for (const node of model.nodes) {
    node.y = levelY[node.depth] || 0;
  }
}

function layoutGrid() {
  const cols = Math.ceil(Math.sqrt(model.nodes.length));
  const maxW = Math.max(...model.nodes.map((n) => n.w));
  const maxH = Math.max(...model.nodes.map((n) => n.h));
  const gap = 26;
  model.nodes.forEach((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    node.x = col * (maxW + gap);
    node.y = row * (maxH + gap);
  });
}

function layoutCircle() {
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
 * which is 300^2 * 160 = 14 million operations on a large model. Bucketing
 * nodes into cells of roughly one ideal edge length reduces each iteration to
 * a handful of neighbours per node, so the layout stays interactive.
 */
function layoutForce() {
  const nodes = model.nodes;
  const maxW = Math.max(...nodes.map((n) => n.w)) + 80;
  const maxH = Math.max(...nodes.map((n) => n.h)) + 80;
  const cols = Math.ceil(Math.sqrt(nodes.length));

  // Seed on a regular grid so the simulation starts without overlaps.
  nodes.forEach((node, index) => {
    node.x = (index % cols) * maxW;
    node.y = Math.floor(index / cols) * maxH;
  });

  const links = model.edges.filter((e) => e.kind === 'contains');
  const ideal = Math.max(110, Math.max(maxW, maxH) * 0.9);
  const cellSize = ideal * 1.6;
  const iterations = 180;
  const disp = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));

  for (let step = 0; step < iterations; step++) {
    const temperature = 1 - step / iterations;
    for (const d of disp.values()) {
      d.x = 0;
      d.y = 0;
    }

    // Bucket nodes by cell for fast neighbour lookup.
    const buckets = new Map();
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
      const d = disp.get(node.id);
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
      const a = disp.get(link.from.id);
      const b = disp.get(link.to.id);
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
      const d = disp.get(node.id);
      const len = Math.hypot(d.x, d.y) || 0.01;
      const limit = Math.min(len, 60 * temperature);
      node.x += (d.x / len) * limit;
      node.y += (d.y / len) * limit;
    }
  }
}

function runLayout(name) {
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

function applyView() {
  viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
}

function contentBox() {
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

function fit() {
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

function scheduleFit() {
  requestAnimationFrame(() => {
    fit();
    // A second pass handles the case where the panel was just shown and the
    // element still reports a zero size on the first frame.
    setTimeout(fit, 60);
  });
}

// --- filters and search ----------------------------------------------------

function applyFilters() {
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

function applySearch() {
  if (!searchTerm) {
    for (const node of model.nodes) {
      if (node.el) {
        node.el.classList.remove('match', 'dim');
      }
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

function selectNode(node) {
  for (const other of model.nodes) {
    if (other.el) {
      other.el.classList.toggle('selected', other === node);
    }
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
  const parts = [];
  if (node.kids.length) {
    parts.push(`${node.kids.length} child${node.kids.length === 1 ? '' : 'ren'}`);
  }
  parts.push(`${relationships} relationship${relationships === 1 ? '' : 's'}`);
  detailsMeta.textContent = parts.join(', ');
  detailsEl.hidden = false;
}

// --- kind filter -----------------------------------------------------------

function populateKindFilter(nodes) {
  const kinds = [...new Set(nodes.map((n) => n.kind))].sort();
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

function updateStatus() {
  const total = model.nodes.length;
  const visible = model.nodes.filter((n) => n.visible !== false).length;
  statusEl.textContent = visible === total ? `${total} blocks` : `${visible} of ${total} blocks`;
}

// --- export ----------------------------------------------------------------

function exportSvgText() {
  const box = contentBox();
  const pad = 20;
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('width', String(Math.ceil(box.w + pad * 2)));
  clone.setAttribute('height', String(Math.ceil(box.h + pad * 2)));
  clone.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`);
  const inner = clone.querySelector('#viewport');
  if (inner) {
    inner.removeAttribute('transform');
  }
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

function exportStyles() {
  return `
    text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .stereo { font-size: 9px; }
    .name { font-size: 11px; font-weight: 600; }
    .compartment { font-size: 9px; font-style: italic; }
    .row { font-size: 10px; }
    .more { font-style: italic; }
    .selected .block { stroke: #ffffff; stroke-width: 2; }
  `;
}

function exportPng(scale) {
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
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    URL.revokeObjectURL(url);
    vscode.postMessage({ command: 'export', format: 'png', data: canvas.toDataURL('image/png') });
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    vscode.postMessage({ command: 'exportFailed', message: 'PNG export failed' });
  };
  image.src = url;
}

function exportSvg() {
  if (!model.nodes.length) {
    return;
  }
  vscode.postMessage({ command: 'export', format: 'svg', data: exportSvgText() });
}

// --- interaction -----------------------------------------------------------

svg.addEventListener('click', () => selectNode(null));

let dragging = null;
svg.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  // Never start a pan on a block: that would swallow the click.
  if (evt.target.closest && evt.target.closest('.node')) return;
  dragging = { x: evt.clientX, y: evt.clientY, vx: view.x, vy: view.y };
  svg.setPointerCapture(evt.pointerId);
});
svg.addEventListener('pointermove', (evt) => {
  if (!dragging) return;
  view.x = dragging.vx + (evt.clientX - dragging.x);
  view.y = dragging.vy + (evt.clientY - dragging.y);
  applyView();
});
svg.addEventListener('pointerup', (evt) => {
  dragging = null;
  svg.releasePointerCapture(evt.pointerId);
});
svg.addEventListener('pointercancel', () => {
  dragging = null;
});

svg.addEventListener(
  'wheel',
  (evt) => {
    evt.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;
    const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(4, Math.max(0.05, view.k * factor));
    view.x = mx - ((mx - view.x) * next) / view.k;
    view.y = my - ((my - view.y) * next) / view.k;
    view.k = next;
    applyView();
  },
  { passive: false }
);

document.getElementById('zoomIn').addEventListener('click', () => {
  const rect = svg.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, 1.2);
});

document.getElementById('zoomOut').addEventListener('click', () => {
  const rect = svg.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, 1 / 1.2);
});

function zoomAt(mx, my, factor) {
  const next = Math.min(4, Math.max(0.05, view.k * factor));
  view.x = mx - ((mx - view.x) * next) / view.k;
  view.y = my - ((my - view.y) * next) / view.k;
  view.k = next;
  applyView();
}

document.getElementById('fit').addEventListener('click', fit);
document.getElementById('exportPng').addEventListener('click', () => exportPng(2));
document.getElementById('exportSvg').addEventListener('click', exportSvg);

document.getElementById('detailsOpen').addEventListener('click', () => {
  if (selectedId) {
    vscode.postMessage({ command: 'open', id: selectedId });
  }
});

document.getElementById('detailsClose').addEventListener('click', () => selectNode(null));

layoutSelect.addEventListener('change', () => runLayout(layoutSelect.value));
kindSelect.addEventListener('change', () => {
  activeKind = kindSelect.value;
  applyFilters();
  updateStatus();
});

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
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

window.addEventListener('message', (evt) => {
  if (evt.data?.type === 'graph') {
    render(evt.data.data);
    // The panel may still be zero-sized when the first message arrives, so fit
    // again once the layout has settled.
    scheduleFit();
  }
});

applyView();
vscode.postMessage({ command: 'ready' });
