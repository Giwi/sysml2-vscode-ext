import { Token } from 'antlr4';
import type { ParserRuleContext, TerminalNode } from 'antlr4';
import { ruleName } from './parser.js';
import type { ParseResult, SyntaxErrorInfo } from './parser.js';

// ---------------------------------------------------------------------------
// Public model types (LSP-compatible plain shapes)
// ---------------------------------------------------------------------------

export interface Position {
  line: number;
  character: number;
}

export interface LspRange {
  start: Position;
  end: Position;
}

export type RefKind =
  | 'typing'
  | 'specializes'
  | 'subsets'
  | 'redefines'
  | 'crosses'
  | 'import'
  | 'dependency'
  | 'alias';

export interface ResolvedTarget {
  name: string;
  kind: string;
  qname: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

export interface SysmlRef {
  kind: RefKind;
  /** First segment of the referenced qualified name. */
  name: string;
  /** Full reference text, e.g. "ScalarValues::Real" or "a::b::c". */
  text: string;
  range: LspRange;
  resolved?: ResolvedTarget;
}

export interface SysmlSymbol {
  id: string;
  name: string;
  shortName?: string;
  /** Human readable kind, e.g. "Part Definition". */
  kind: string;
  /** Qualified name inside the owning document (namespace path). */
  qname: string;
  /** Kind of the parent symbol, used for hover/outline detail. */
  parentKind?: string;
  parent?: SysmlSymbol;
  /** Synthetic file root (name = file name); top-level symbols hang off it. */
  isFileRoot?: boolean;
  children: SysmlSymbol[];
  refs: SysmlRef[];
  nameRange: LspRange;
  range: LspRange;
  uri: string;
  library: boolean;
}

export interface DocumentModel {
  uri: string;
  library: boolean;
  /** Synthetic root representing the file itself. */
  root: SysmlSymbol;
  /** Top-level symbols (children of root). */
  symbols: SysmlSymbol[];
  errors: SyntaxErrorInfo[];
}

// ---------------------------------------------------------------------------
// Kind tables
// ---------------------------------------------------------------------------

const DEFINITION_KINDS: Record<string, string> = {
  partDefinition: 'Part Definition',
  itemDefinition: 'Item Definition',
  attributeDefinition: 'Attribute Definition',
  portDefinition: 'Port Definition',
  connectionDefinition: 'Connection Definition',
  interfaceDefinition: 'Interface Definition',
  allocationDefinition: 'Allocation Definition',
  flowDefinition: 'Flow Definition',
  actionDefinition: 'Action Definition',
  calculationDefinition: 'Calculation Definition',
  stateDefinition: 'State Definition',
  constraintDefinition: 'Constraint Definition',
  requirementDefinition: 'Requirement Definition',
  concernDefinition: 'Concern Definition',
  caseDefinition: 'Case Definition',
  analysisCaseDefinition: 'Analysis Case Definition',
  verificationCaseDefinition: 'Verification Case Definition',
  useCaseDefinition: 'Use Case Definition',
  viewDefinition: 'View Definition',
  viewpointDefinition: 'Viewpoint Definition',
  renderingDefinition: 'Rendering Definition',
  metadataDefinition: 'Metadata Definition',
  occurrenceDefinition: 'Occurrence Definition',
  individualDefinition: 'Individual Definition',
};

const USAGE_KINDS: Record<string, string> = {
  partUsage: 'Part',
  itemUsage: 'Item',
  attributeUsage: 'Attribute',
  portUsage: 'Port',
  interfaceUsage: 'Interface',
  connectionUsage: 'Connection',
  allocationUsage: 'Allocation',
  flowUsage: 'Flow',
  actionUsage: 'Action',
  stateUsage: 'State',
  occurrenceUsage: 'Occurrence',
  individualUsage: 'Individual',
  portionUsage: 'Portion',
  eventOccurrenceUsage: 'Event Occurrence',
  enumerationUsage: 'Enumeration Value',
  referenceUsage: 'Reference',
  defaultReferenceUsage: 'Usage',
  endFeatureUsage: 'End Feature',
};

const DECL_KINDS: Record<string, string> = {
  package: 'Package',
  libraryPackage: 'Package',
  namespace: 'Namespace',
  feature: 'Feature',
  connectorDeclaration: 'Connector',
  bindingConnectorDeclaration: 'Binding Connector',
  successionDeclaration: 'Succession',
  flowDeclaration: 'Flow',
  messageDeclaration: 'Message',
  enumerationDefinition: 'Enumeration',
};

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function childContexts(ctx: ParserRuleContext, name?: string): ParserRuleContext[] {
  const out: ParserRuleContext[] = [];
  for (let i = 0; i < ctx.getChildCount(); i++) {
    const c = ctx.getChild(i);
    if (isParserRuleContext(c) && (name === undefined || ruleName(c) === name)) {
      out.push(c);
    }
  }
  return out;
}

function firstChildContext(ctx: ParserRuleContext, name: string): ParserRuleContext | undefined {
  return childContexts(ctx, name)[0];
}

function childTerminals(ctx: ParserRuleContext): TerminalNode[] {
  const out: TerminalNode[] = [];
  for (let i = 0; i < ctx.getChildCount(); i++) {
    const c = ctx.getChild(i);
    if (isTerminalNode(c)) {
      out.push(c);
    }
  }
  return out;
}

// `instanceof` is unreliable across the CJS antlr4 bundle, so duck-type:
// ParserRuleContext carries ruleIndex + start token, TerminalNode carries symbol.
function isParserRuleContext(c: unknown): c is ParserRuleContext {
  const any = c as { ruleIndex?: unknown; start?: unknown; symbol?: unknown };
  return typeof any?.ruleIndex === 'number' && any.start !== undefined && any.symbol === undefined;
}

function isTerminalNode(c: unknown): c is TerminalNode {
  const any = c as { symbol?: unknown; ruleIndex?: unknown };
  return any?.symbol !== undefined && any?.ruleIndex === undefined;
}

function tokenRange(ctx: ParserRuleContext): LspRange {
  const startTok = ctx.start;
  const stopTok = ctx.stop ?? startTok;
  const startColumn = startTok?.column ?? 0;
  const endColumn = stopTok?.column ?? 0;
  const endChar =
    stopTok && stopTok.type !== Token.EOF
      ? endColumn + (stopTok.text?.length ?? 0)
      : endColumn;
  return {
    start: { line: Math.max(0, (startTok?.line ?? 1) - 1), character: startColumn },
    end: { line: Math.max(0, (stopTok?.line ?? 1) - 1), character: endChar },
  };
}

function terminalText(t: TerminalNode): string {
  const text = t.getText() ?? '';
  if (text.length >= 2 && (text[0] === "'" || text[0] === '"') && text.endsWith(text[0])) {
    return text.slice(1, -1);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Identification extraction
// ---------------------------------------------------------------------------

/** Recursively search `*Declaration` wrappers (max 3 levels) for an identification. */
function findIdentification(ctx: ParserRuleContext, depth = 0): ParserRuleContext | undefined {
  if (depth > 3) {
    return undefined;
  }
  for (let i = 0; i < ctx.getChildCount(); i++) {
    const c = ctx.getChild(i);
    if (!isParserRuleContext(c)) {
      continue;
    }
    const rule = ruleName(c);
    if (!/Declaration$/.test(rule)) {
      continue; // never descend into bodies or bodies' elements
    }
    const direct =
      firstChildContext(c, 'identification') ?? firstChildContext(c, 'featureIdentification');
    if (direct) {
      return direct;
    }
    const nested = findIdentification(c, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

interface Identification {
  name?: string;
  shortName?: string;
  range: LspRange;
}

/** `name` rule contexts of an identification/featureIdentification context. */
function identificationOf(ctx: ParserRuleContext): Identification | undefined {
  let id: ParserRuleContext | undefined;

  switch (ruleName(ctx)) {
    case 'definition': {
      const decl = firstChildContext(ctx, 'definitionDeclaration');
      id = decl && firstChildContext(decl, 'identification');
      break;
    }
    case 'usage': {
      const decl = firstChildContext(ctx, 'usageDeclaration');
      id = decl && firstChildContext(decl, 'identification');
      break;
    }
    case 'enumerationDefinition':
    case 'package':
    case 'libraryPackage':
    case 'namespace': {
      const decl =
        firstChildContext(ctx, 'packageDeclaration') ??
        firstChildContext(ctx, 'namespaceDeclaration') ??
        firstChildContext(ctx, 'definitionDeclaration');
      id = decl && firstChildContext(decl, 'identification');
      break;
    }
    case 'feature': {
      const decl = firstChildContext(ctx, 'featureDeclaration');
      id = decl && (firstChildContext(decl, 'featureIdentification') ?? firstChildContext(decl, 'identification'));
      break;
    }
    default: {
      // Specialized rules name themselves through a wrapper declaration:
      // definitionDeclaration for constraint/requirement/action/state definitions,
      // actionUsageDeclaration for state/action usages, and so on. The
      // identification can sit one or two levels below the wrapper
      // (actionUsageDeclaration -> usageDeclaration -> identification), so
      // search a few levels deep rather than guessing the exact path.
      id =
        findIdentification(ctx) ??
        firstChildContext(ctx, 'identification') ??
        firstChildContext(ctx, 'featureIdentification');
      break;
    }
  }

  if (!id) {
    return undefined;
  }
  const names = childContexts(id, 'name');
  if (names.length === 0) {
    return undefined;
  }
  const last = names[names.length - 1];
  const first = names[0];
  return {
    name: terminalNames(last),
    shortName: names.length > 1 ? terminalNames(first) : undefined,
    range: tokenRange(last),
  };
}

/** Concatenated text of the `name` rule (IDENTIFIER | STRING | unreservedKeyword). */
function terminalNames(nameCtx: ParserRuleContext): string {
  const t = childTerminals(nameCtx)[0];
  return t ? terminalText(t) : nameCtx.getText();
}

// ---------------------------------------------------------------------------
// Qualified name helpers
// ---------------------------------------------------------------------------

function qnSegments(qn: ParserRuleContext): string[] {
  return childContexts(qn, 'name').map(terminalNames);
}

function qnText(qn: ParserRuleContext): string {
  return qnSegments(qn).join('::');
}

/** First `qualifiedName` of typing rules (featureTyping variants). */
function firstQualifiedName(ctx: ParserRuleContext): ParserRuleContext | undefined {
  const direct = childContexts(ctx, 'qualifiedName');
  if (direct.length > 0) {
    return direct[0];
  }
  for (const sub of ['ownedFeatureTyping', 'conjugatedPortTyping']) {
    const c = firstChildContext(ctx, sub);
    if (c) {
      const qns = childContexts(c, 'qualifiedName');
      if (qns.length > 0) {
        return qns[0];
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Document model construction
// ---------------------------------------------------------------------------

function isDeclRule(rule: string): boolean {
  return (
    rule === 'definition' ||
    rule === 'usage' ||
    rule in DEFINITION_KINDS ||
    rule in USAGE_KINDS ||
    rule in DECL_KINDS
  );
}

function kindForDecl(rule: string, parentRule: string | undefined): string {
  if (rule === 'definition') {
    return (parentRule && DEFINITION_KINDS[parentRule]) || 'Definition';
  }
  if (rule === 'usage') {
    return (parentRule && USAGE_KINDS[parentRule]) || 'Usage';
  }
  // The symbol came from a specialized rule context (constraintDefinition,
  // requirementDefinition, actionUsage, ...); name it directly.
  if (DEFINITION_KINDS[rule] || USAGE_KINDS[rule]) {
    return DEFINITION_KINDS[rule] ?? USAGE_KINDS[rule];
  }
  return DECL_KINDS[rule] ?? 'Element';
}

export function buildDocumentModel(uri: string, parse: ParseResult, library: boolean): DocumentModel {
  const file = uri.split(/[\\/]/).pop() ?? uri;
  const root: SysmlSymbol = {
    id: `${uri}#root`,
    name: file,
    kind: 'File',
    qname: '',
    children: [],
    refs: [],
    nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    uri,
    library,
    isFileRoot: true,
  };
  const model: DocumentModel = { uri, library, root, symbols: [], errors: parse.errors };

  function makeSymbol(ctx: ParserRuleContext, rule: string, parent: SysmlSymbol): SysmlSymbol | undefined {
    const ident = identificationOf(ctx);
    if (!ident || !ident.name) {
      return undefined;
    }
    const range = tokenRange(ctx);
    const parentRuleOfCtx = ctx.parentCtx ? ruleName(ctx.parentCtx) : undefined;
    const kind = kindForDecl(rule, parentRuleOfCtx);
    const sym: SysmlSymbol = {
      id: `${uri}#${range.start.line}:${range.start.character}`,
      name: ident.name,
      shortName: ident.shortName,
      kind,
      qname: parent.qname ? `${parent.qname}::${ident.name}` : ident.name,
      parentKind: parent.kind,
      parent,
      children: [],
      refs: [],
      nameRange: ident.range,
      range,
      uri,
      library,
    };
    return sym;
  }

  function addRef(scope: SysmlSymbol | undefined, kind: RefKind, qn: ParserRuleContext | undefined): void {
    if (!qn || !scope) {
      return;
    }
    const segs = qnSegments(qn);
    if (segs.length === 0) {
      return;
    }
    scope.refs.push({ kind, name: segs[0], text: qnText(qn), range: tokenRange(qn) });
  }

  /** Refs attached to the nearest named ancestor (`scope`). */
  function collectRefs(ctx: ParserRuleContext, rule: string, scope: SysmlSymbol): void {
    switch (rule) {
      case 'featureTyping':
        addRef(scope, 'typing', firstQualifiedName(ctx));
        break;
      case 'ownedReferenceSubsetting':
        addRef(scope, 'subsets', firstQualifiedName(ctx));
        break;
      case 'subsetting':
        addRef(scope, 'subsets', firstQualifiedName(ctx));
        break;
      case 'redefinition':
        addRef(scope, 'redefines', firstQualifiedName(ctx));
        break;
      case 'crosses':
        addRef(scope, 'crosses', firstQualifiedName(ctx));
        break;
      case 'specializationPart':
      case 'subclassificationPart':
      case 'superclassingPart':
        for (const owned of childContexts(ctx, 'ownedSubclassification')) {
          for (const qn of childContexts(owned, 'qualifiedName')) {
            addRef(scope, 'specializes', qn);
          }
        }
        break;
      case 'importRule':
        collectQualifiedNamesScoped(ctx, scope, 'import');
        break;
      case 'dependency':
        collectQualifiedNamesScoped(ctx, scope, 'dependency');
        break;
      case 'aliasMember': {
        for (const qn of childContexts(ctx, 'qualifiedName')) {
          addRef(scope, 'alias', qn);
          break;
        }
        break;
      }
    }
  }

  /**
   * Collect qualifiedName descendants without descending into nested
   * declarations (so refs are attributed to the nearest named element).
   */
  function collectQualifiedNamesScoped(
    ctx: ParserRuleContext,
    scope: SysmlSymbol,
    kind: RefKind,
    isRoot = true
  ): void {
    for (let i = 0; i < ctx.getChildCount(); i++) {
      const c = ctx.getChild(i);
      if (!isParserRuleContext(c)) {
        continue;
      }
      const rule = ruleName(c);
      if (!isRoot && isDeclRule(rule)) {
        continue;
      }
      if (rule === 'qualifiedName') {
        addRef(scope, kind, c);
      } else {
        collectQualifiedNamesScoped(c, scope, kind, false);
      }
    }
  }

  function walk(ctx: ParserRuleContext, scope: SysmlSymbol | undefined): void {
    const rule = ruleName(ctx);

    if (isDeclRule(rule)) {
      const sym = makeSymbol(ctx, rule, scope ?? root);
      if (sym) {
        (scope ?? root).children.push(sym);
        walkChildren(ctx, sym);
        return;
      }
      // Anonymous declaration: transparent, refs/children go to parent scope.
    }

    if (scope) {
      collectRefs(ctx, rule, scope);
    }

    // Named connector/succession/etc. declarations create symbols too.
    if (rule in DECL_KINDS && rule !== 'package' && rule !== 'libraryPackage' && rule !== 'namespace') {
      const sym = makeSymbol(ctx, rule, scope ?? root);
      if (sym) {
        (scope ?? root).children.push(sym);
        walkChildren(ctx, sym);
        return;
      }
    }

    walkChildren(ctx, scope);
  }

  function walkChildren(ctx: ParserRuleContext, scope: SysmlSymbol | undefined): void {
    for (let i = 0; i < ctx.getChildCount(); i++) {
      const c = ctx.getChild(i);
      if (isParserRuleContext(c)) {
        walk(c, scope);
      }
    }
  }

  walkChildren(parse.tree, root);
  model.symbols = root.children;
  return model;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Deepest symbol whose full range contains the position. */
export function symbolAtPosition(model: DocumentModel, line: number, character: number): SysmlSymbol | undefined {
  let best: SysmlSymbol | undefined;
  const visit = (sym: SysmlSymbol): void => {
    if (contains(sym.range, line, character)) {
      if (sym !== model.root) {
        best = sym;
      }
      for (const c of sym.children) {
        visit(c);
      }
    }
  };
  for (const s of model.symbols) {
    visit(s);
  }
  return best;
}

/** Ref whose range contains the position (deepest scope first). */
export function refAtPosition(model: DocumentModel, line: number, character: number): SysmlRef | undefined {
  let best: SysmlRef | undefined;
  const visit = (sym: SysmlSymbol): void => {
    for (const ref of sym.refs) {
      if (contains(ref.range, line, character)) {
        best = ref;
      }
    }
    for (const c of sym.children) {
      visit(c);
    }
  };
  visit(model.root);
  return best;
}

function contains(range: LspRange, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.character) {
    return false;
  }
  if (line === range.end.line && character > range.end.character) {
    return false;
  }
  return true;
}

export function flattenSymbols(model: DocumentModel): SysmlSymbol[] {
  const out: SysmlSymbol[] = [];
  const visit = (sym: SysmlSymbol): void => {
    for (const c of sym.children) {
      out.push(c);
      visit(c);
    }
  };
  visit(model.root);
  return out;
}
