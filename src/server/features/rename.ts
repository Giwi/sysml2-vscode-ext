import { ErrorCodes, ResponseError } from 'vscode-languageserver/node.js';
import type { TextEdit } from 'vscode-languageserver/node.js';
import { refAtPosition, symbolAtPosition } from '../model.js';
import type { LspRange, SysmlSymbol } from '../model.js';
import { rangeContains, symbolByQName } from './context.js';
import type { FeatureContext } from './context.js';

/** One `::`-separated segment of a reference, with character offsets in `text`. */
interface RefSegment {
  name: string;
  start: number;
  end: number;
}

/**
 * Split a reference into segments with exact offsets.
 *
 * Using the reference text (not the document) keeps this working for files that
 * are indexed from disk and therefore not open in an editor.
 */
function refSegments(ref: { text: string }): RefSegment[] {
  const text = ref.text;
  const segments: RefSegment[] = [];
  let cursor = 0;
  for (const part of text.split('::')) {
    const index = text.indexOf(part, cursor);
    segments.push({ name: part, start: index, end: index + part.length });
    cursor = index + part.length;
  }
  return segments;
}

/** Range of one segment inside a (single-line) reference range. */
function segmentRange(ref: { range: LspRange }, segment: RefSegment): LspRange {
  return {
    start: { line: ref.range.start.line, character: ref.range.start.character + segment.start },
    end: { line: ref.range.start.line, character: ref.range.start.character + segment.end },
  };
}

/** The segment under the cursor, used by prepareRename. */
function segmentAt(
  ref: { range: LspRange; text: string },
  line: number,
  character: number
): RefSegment | undefined {
  if (line !== ref.range.start.line) {
    return undefined;
  }
  const offset = character - ref.range.start.character;
  return refSegments(ref).find((segment) => offset >= segment.start && offset <= segment.end);
}

/** Index of the segment that names the resolved symbol (the last match). */
function targetSegmentIndex(ref: { text: string }, name: string): number {
  const segments = refSegments(ref);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].name === name) {
      return i;
    }
  }
  return -1;
}

/**
 * Refuse a rename that would collide with a sibling declaration. Namespaces
 * cannot contain two elements with the same name, so replacing the text would
 * only introduce a duplicate-declaration error.
 */
function collisionError(declaration: SysmlSymbol | undefined, newName: string): string | undefined {
  if (!declaration || !declaration.parent) {
    return undefined;
  }
  const clash = declaration.parent.children.find(
    (child) => child !== declaration && child.name === newName
  );
  if (!clash) {
    return undefined;
  }
  const scope = declaration.parent.qname || 'the file root';
  return `'${newName}' already exists in ${scope}`;
}

/** Rename declarations and every resolved reference, segment by segment. */
export function registerRename(ctx: FeatureContext): void {
  ctx.connection.onPrepareRename((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    if (!model) {
      return null;
    }
    const { line, character } = params.position;

    // A reference inside a declaration must win over the enclosing declaration.
    const ref = refAtPosition(model, line, character);
    if (ref?.resolved) {
      if (ref.range.start.line !== ref.range.end.line) {
        return null;
      }
      if (ctx.workspace.docs.get(ref.resolved.uri)?.library) {
        return null; // the standard library is read-only
      }
      const segment = segmentAt(ref, line, character);
      // Only the segment naming the resolved symbol can be renamed here.
      if (!segment || segment.name !== ref.resolved.name) {
        return null;
      }
      return { range: segmentRange(ref, segment), placeholder: segment.name };
    }

    const sym = symbolAtPosition(model, line, character);
    if (sym && !sym.isFileRoot && rangeContains(sym.nameRange, line, character)) {
      if (sym.library) {
        return null; // the standard library is read-only
      }
      return { range: sym.nameRange, placeholder: sym.name };
    }
    return null;
  });

  ctx.connection.onRenameRequest((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    if (!model) {
      return null;
    }
    const newName = params.newName;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
      throw new ResponseError(ErrorCodes.InvalidRequest, `'${newName}' is not a valid SysML name.`);
    }

    const { line, character } = params.position;
    const ref = refAtPosition(model, line, character);
    let targetId: string | undefined;
    let targetQName: string | undefined;
    let targetUri: string | undefined;
    let targetName: string | undefined;

    if (ref?.resolved) {
      if (ref.range.start.line !== ref.range.end.line) {
        return null;
      }
      if (ctx.workspace.docs.get(ref.resolved.uri)?.library) {
        return null; // the standard library is read-only
      }
      const segment = segmentAt(ref, line, character);
      // Renaming an intermediate qualifier is not supported: only the segment
      // that actually names the resolved symbol is rewritten.
      if (!segment || segment.name !== ref.resolved.name) {
        return null;
      }
      targetName = ref.resolved.name;
      targetQName = ref.resolved.qname;
      targetUri = ref.resolved.uri;
    } else {
      const sym = symbolAtPosition(model, line, character);
      if (!sym || sym.isFileRoot || sym.library) {
        return null;
      }
      if (!rangeContains(sym.nameRange, line, character)) {
        return null;
      }
      targetId = sym.id;
      targetName = sym.name;
      targetQName = sym.qname;
      targetUri = model.uri;
    }
    if (!targetQName || !targetUri) {
      return null;
    }

    // Locate the declaration to check for a name clash in its scope.
    let declaration: SysmlSymbol | undefined;
    if (targetId) {
      declaration =
        symbolByQName(model, targetQName) ?? symbolAtPosition(model, line, character);
    } else {
      const owner = ctx.workspace.docs.get(targetUri);
      declaration = owner ? symbolByQName(owner, targetQName) : undefined;
    }

    const collision = collisionError(declaration, newName);
    if (collision) {
      throw new ResponseError(ErrorCodes.InvalidRequest, `Cannot rename: ${collision}.`);
    }

    const changes: Record<string, TextEdit[]> = {};
    const addEdit = (uri: string, range: LspRange): void => {
      (changes[uri] ??= []).push({ range, newText: newName });
    };

    for (const docModel of ctx.workspace.docs.values()) {
      if (docModel.library) {
        continue;
      }
      const visit = (sym: SysmlSymbol): void => {
        if (sym.id === targetId) {
          addEdit(docModel.uri, sym.nameRange);
        }
        for (const r of sym.refs) {
          if (!r.resolved || r.resolved.qname !== targetQName || r.resolved.uri !== targetUri) {
            continue;
          }
          if (r.range.start.line !== r.range.end.line) {
            addEdit(docModel.uri, r.range);
            continue;
          }
          // Replace only the segment that names the symbol, preserving any
          // qualifier: `Q::Base` -> `Q::Root`, never `Root`.
          const index = targetSegmentIndex(r, targetName!);
          const segments = refSegments(r);
          if (index < 0) {
            addEdit(docModel.uri, r.range);
          } else {
            addEdit(docModel.uri, segmentRange(r, segments[index]));
          }
        }
        for (const child of sym.children) {
          visit(child);
        }
      };
      visit(docModel.root);
    }

    return { changes };
  });
}
