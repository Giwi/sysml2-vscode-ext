import type { GraphData, GraphEdge, GraphNode } from '../../shared/protocol.js';
import type { SysmlSymbol } from '../model.js';
import { symbolByQName } from './context.js';
import type { FeatureContext } from './context.js';

/**
 * Containment tree plus cross-references for one document.
 *
 * The walk is bounded by `maxNodes` so a pathological file cannot freeze the
 * webview. Cross-reference targets are added only when they belong to a user
 * file: the standard library would add thousands of nodes for no benefit.
 */
function buildBdd(ctx: FeatureContext, uri: string, maxNodes?: number): GraphData | null {
  const model = ctx.workspace.docs.get(uri);
  if (!model) {
    return null;
  }
  const limit = maxNodes ?? ctx.config.maxGraphNodes();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  const addNode = (sym: SysmlSymbol, depth: number): boolean => {
    if (nodes.length >= limit) {
      return false;
    }
    if (!nodeIds.has(sym.id)) {
      nodeIds.add(sym.id);
      const typing = sym.refs.find((ref) => ref.kind === 'typing');
      nodes.push({
        id: sym.id,
        label: sym.name,
        kind: sym.kind,
        depth,
        children: sym.children.length,
        type: typing?.text,
        multiplicity: sym.multiplicity,
      });
    }
    return true;
  };

  const visit = (sym: SysmlSymbol, depth: number): void => {
    if (!addNode(sym, depth)) {
      return;
    }
    for (const child of sym.children) {
      edges.push({ from: sym.id, to: child.id, kind: 'contains', label: '' });
      visit(child, depth + 1);
    }
    for (const ref of sym.refs) {
      if (!ref.resolved) {
        continue;
      }
      const targetModel = ctx.workspace.docs.get(ref.resolved.uri);
      const target = targetModel?.root.children.find((c) => c.qname === ref.resolved!.qname);
      if (!target || targetModel?.library) {
        continue;
      }
      addNode(target, depth);
      edges.push({
        from: sym.id,
        to: target.id,
        kind: ref.kind,
        label:
          ref.kind === 'typing'
            ? 'typed by'
            : ref.kind === 'specializes'
              ? 'specializes'
              : ref.kind,
      });
    }
  };

  for (const sym of model.symbols) {
    visit(sym, 0);
  }

  return { uri: model.uri, nodes, edges, truncated: nodes.length >= limit };
}

/**
 * Internal block diagram for one part definition or usage.
 *
 * Parts become nodes, ports become border decorations, and `connect` statements
 * become labelled edges between the owning parts. The payload reuses the graph
 * shape so the same webview renderer can draw it.
 */
function buildIbd(
  ctx: FeatureContext,
  params: { uri: string; qname?: string; line?: number; character?: number }
): GraphData | null {
  const model = ctx.workspace.docs.get(params.uri);
  if (!model) {
    return null;
  }

  let context: SysmlSymbol | undefined;
  if (params.qname) {
    context = symbolByQName(model, params.qname);
  }
  if (!context && typeof params.line === 'number') {
    // Declaration ranges start at the name, so a cursor on the leading keyword
    // or indentation would fall back to the package. Match on the line span
    // instead and keep the deepest definition.
    const targetLine = params.line;
    const visit = (symbol: SysmlSymbol): void => {
      if (targetLine < symbol.range.start.line || targetLine > symbol.range.end.line) {
        return;
      }
      if (!symbol.isFileRoot && /Definition$/.test(symbol.kind)) {
        context = symbol;
      }
      for (const child of symbol.children) {
        visit(child);
      }
    };
    for (const symbol of model.symbols) {
      visit(symbol);
    }
  }
  if (!context) {
    context =
      model.symbols.find((symbol) => /Part Definition/.test(symbol.kind)) ?? model.symbols[0];
  }
  if (!context) {
    return null;
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const included = new Map<string, SysmlSymbol>();

  /**
   * Ports of a part: its own port children, or the ports of its type
   * definition when the part only declares `part engine : Engine;`.
   */
  const portsOf = (symbol: SysmlSymbol): SysmlSymbol[] => {
    const own = symbol.children.filter((child) => /Port/.test(child.kind));
    if (own.length) {
      return own;
    }
    const typing = symbol.refs.find((ref) => ref.kind === 'typing' && ref.resolved);
    if (!typing?.resolved) {
      return [];
    }
    const owner = ctx.workspace.docs.get(typing.resolved.uri);
    const typeSymbol = owner ? symbolByQName(owner, typing.resolved.qname) : undefined;
    return typeSymbol ? typeSymbol.children.filter((child) => /Port/.test(child.kind)) : [];
  };

  const add = (symbol: SysmlSymbol, depth: number): void => {
    if (included.has(symbol.id)) {
      return;
    }
    included.set(symbol.id, symbol);
    const typing = symbol.refs.find((ref) => ref.kind === 'typing');
    nodes.push({
      id: symbol.id,
      label: symbol.name,
      kind: symbol.kind,
      depth,
      children: symbol.children.length,
      type: typing?.text,
      multiplicity: symbol.multiplicity,
      ports: portsOf(symbol).map((port) => ({
        name: port.name,
        type: port.refs.find((ref) => ref.kind === 'typing')?.text,
      })),
    });
  };

  const visit = (symbol: SysmlSymbol, depth: number): void => {
    add(symbol, depth);
    for (const child of symbol.children) {
      if (/Port/.test(child.kind) || child.kind === 'File') {
        continue;
      }
      edges.push({ from: symbol.id, to: child.id, kind: 'contains', label: '' });
      visit(child, depth + 1);
    }
  };
  visit(context, 0);

  const byQName = new Map([...included.values()].map((symbol) => [symbol.qname, symbol]));
  for (const connector of model.connectors) {
    const owner = byQName.get(connector.ownerQname);
    if (!owner) {
      continue;
    }
    const fromPart = owner.children.find((child) => child.name === connector.from.owner);
    const toPart = owner.children.find((child) => child.name === connector.to.owner);
    if (!fromPart || !toPart) {
      continue;
    }
    const hasPort = (part: SysmlSymbol, portName: string): boolean =>
      portsOf(part).some((port) => port.name === portName);
    if (!hasPort(fromPart, connector.from.port) || !hasPort(toPart, connector.to.port)) {
      continue;
    }
    edges.push({
      from: fromPart.id,
      to: toPart.id,
      kind: 'connection',
      label: `${connector.from.port} \u2192 ${connector.to.port}`,
    });
  }

  return { uri: model.uri, nodes, edges, truncated: false };
}

/** Register the block definition and internal block diagram requests. */
export function registerGraph(ctx: FeatureContext): void {
  ctx.connection.onRequest(
    'sysml/graph',
    (params: { uri: string; maxNodes?: number }) => buildBdd(ctx, params.uri, params.maxNodes)
  );
  ctx.connection.onRequest(
    'sysml/ibd',
    (params: { uri: string; qname?: string; line?: number; character?: number }) =>
      buildIbd(ctx, params)
  );
}
