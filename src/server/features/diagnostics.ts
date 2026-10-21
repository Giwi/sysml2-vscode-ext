import * as fs from 'node:fs';
import { DiagnosticSeverity } from 'vscode-languageserver/node.js';
import type { Diagnostic } from 'vscode-languageserver/node.js';
import { parseText } from '../parser.js';
import type { DocumentModel, SysmlSymbol } from '../model.js';
import type { FeatureContext } from './context.js';

function toFsPath(uri: string): string {
  return decodeURIComponent(uri.slice(7));
}

/** Parse errors, duplicate declarations and unresolved references. */
export function validate(ctx: FeatureContext, model: DocumentModel): void {
  const diagnostics: Diagnostic[] = [];

  for (const error of model.errors) {
    diagnostics.push({
      range: {
        start: { line: error.line, character: error.column },
        end: { line: error.line, character: error.column + 1 },
      },
      severity: DiagnosticSeverity.Error,
      source: 'sysml',
      message: `Syntax error: ${error.message}`,
    });
  }

  // Duplicate declarations are a local property of the file, so they are
  // reported even when the standard library is not indexed.
  const checkDuplicates = (sym: SysmlSymbol): void => {
    const seen = new Map<string, SysmlSymbol>();
    for (const child of sym.children) {
      const prev = seen.get(child.name);
      if (prev) {
        diagnostics.push({
          range: child.nameRange,
          severity: DiagnosticSeverity.Error,
          source: 'sysml',
          message: `Duplicate declaration '${child.name}' (already declared as ${prev.kind.toLowerCase()})`,
        });
      } else {
        seen.set(child.name, child);
      }
      checkDuplicates(child);
    }
  };
  checkDuplicates(model.root);

  // Unresolved-reference warnings need the library index: without it every
  // standard-library type would look unresolved and flood the file.
  if (ctx.config.unresolvedWarnings() && ctx.config.libraryEnabled()) {
    const visit = (sym: SysmlSymbol): void => {
      for (const ref of sym.refs) {
        if (!ref.resolved && ref.kind !== 'dependency') {
          diagnostics.push({
            range: ref.range,
            severity: DiagnosticSeverity.Warning,
            source: 'sysml',
            message: `Unresolved reference '${ref.text}'`,
          });
        }
      }
      for (const child of sym.children) {
        visit(child);
      }
    };
    visit(model.root);
  }

  ctx.connection.sendDiagnostics({ uri: model.uri, diagnostics });
}

/** Revalidate every open document after an index or configuration change. */
export function validateOpenDocuments(ctx: FeatureContext): void {
  for (const doc of ctx.documents.all()) {
    const model = ctx.workspace.docs.get(doc.uri);
    if (model) {
      ctx.workspace.resolveRefs(model);
      validate(ctx, model);
    }
  }
}

/**
 * Document lifecycle and file watcher wiring for diagnostics.
 *
 * Keeps the parsed workspace in sync with edits and external changes and
 * notifies the extension when a diagram or the matrix should refresh.
 */
export function registerDiagnostics(ctx: FeatureContext): void {
  const updateDocument = (uri: string, text: string, library: boolean): DocumentModel =>
    ctx.workspace.update(uri, parseText(text, false), library);

  ctx.documents.onDidOpen((event) => {
    const model = updateDocument(
      event.document.uri,
      event.document.getText(),
      ctx.config.isLibraryUri(event.document.uri)
    );
    validate(ctx, model);
  });

  ctx.documents.onDidChangeContent((event) => {
    const model = updateDocument(
      event.document.uri,
      event.document.getText(),
      ctx.config.isLibraryUri(event.document.uri)
    );
    validate(ctx, model);
    ctx.connection.sendNotification('sysml/modelChanged', { uri: event.document.uri });
  });

  ctx.documents.onDidClose((event) => {
    ctx.connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  ctx.connection.onDidChangeWatchedFiles(async (params) => {
    for (const change of params.changes) {
      const uri = change.uri;
      if (ctx.documents.get(uri)) {
        continue; // open docs are handled by TextDocuments
      }
      if (change.type === 3 /* Deleted */) {
        ctx.workspace.remove(uri);
        continue;
      }
      try {
        updateDocument(uri, fs.readFileSync(toFsPath(uri), 'utf8'), ctx.config.isLibraryUri(uri));
      } catch {
        ctx.workspace.remove(uri);
      }
    }
    validateOpenDocuments(ctx);
    ctx.connection.sendNotification('sysml/modelChanged', { uri: '' });
  });
}
