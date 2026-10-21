/**
 * Wire types shared by the language server, the extension host and the
 * webview. Keeping them in one module prevents the client and the server from
 * drifting apart when a payload gains a field (for example `type` and
 * `multiplicity` on graph nodes).
 */

// --- Structure graph (`sysml/graph`) ---

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  depth: number;
  children: number;
  /** Declared type, e.g. `Wheel` in `part wheel : Wheel`. */
  type?: string;
  /** Declared multiplicity without brackets, e.g. `4`. */
  multiplicity?: string;
  /** Ports on the block border, used by the internal block diagram. */
  ports?: { name: string; type?: string }[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  label: string;
}

export interface GraphData {
  uri: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

// --- Model Explorer (`sysml/modelTree`) ---

export interface ModelTreeNode {
  name: string;
  kind: string;
  qname: string;
  uri: string;
  line: number;
  character: number;
  children: ModelTreeNode[];
}

// --- Traceability (`sysml/traceability`) ---

export interface TraceTarget {
  id: string;
  name: string;
  qname: string;
  uri: string;
  line: number;
  character: number;
  /** Position inside the declaration body, used to insert `verify` links. */
  insertLine?: number;
  insertCharacter?: number;
  /** True when the verification case has no objective block yet. */
  needsObjective?: boolean;
}

export interface TraceLink {
  requirement: string;
  verification: string;
}

export interface TraceabilityPayload {
  requirements: TraceTarget[];
  verifications: TraceTarget[];
  links: TraceLink[];
}

// --- Validation (`sysml/validate`) ---

export interface ValidationError {
  line: number;
  column: number;
  message: string;
}

export interface ValidationResult {
  errors: ValidationError[];
}

// --- Background indexing progress (`sysml/indexProgress`) ---

export interface IndexProgress {
  done: number;
  total: number;
}
