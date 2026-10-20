import { buildDocumentModel, flattenSymbols } from './model.js';
import type { DocumentModel, SysmlSymbol } from './model.js';
import type { ParseResult } from './parser.js';

export interface IndexedSymbol {
  sym: SysmlSymbol;
  model: DocumentModel;
}

export class Workspace {
  readonly docs = new Map<string, DocumentModel>();
  private readonly byLastName = new Map<string, IndexedSymbol[]>();

  add(model: DocumentModel): void {
    if (this.docs.get(model.uri)) {
      this.remove(model.uri);
    }
    this.docs.set(model.uri, model);
    for (const sym of flattenSymbols(model)) {
      let list = this.byLastName.get(sym.name);
      if (!list) {
        list = [];
        this.byLastName.set(sym.name, list);
      }
      list.push({ sym, model });
    }
  }

  remove(uri: string): void {
    const model = this.docs.get(uri);
    if (!model) {
      return;
    }
    this.docs.delete(uri);
    for (const sym of flattenSymbols(model)) {
      const list = this.byLastName.get(sym.name);
      if (list) {
        const idx = list.findIndex((e) => e.sym.id === sym.id);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
        if (list.length === 0) {
          this.byLastName.delete(sym.name);
        }
      }
    }
  }

  update(uri: string, parse: ParseResult, library: boolean): DocumentModel {
    const model = buildDocumentModel(uri, parse, library);
    this.add(model);
    this.resolveRefs(model);
    return model;
  }

  lookupByName(name: string): IndexedSymbol[] {
    return this.byLastName.get(name) ?? [];
  }

  allSymbols(): IndexedSymbol[] {
    const out: IndexedSymbol[] = [];
    for (const model of this.docs.values()) {
      for (const sym of flattenSymbols(model)) {
        out.push({ sym, model });
      }
    }
    return out;
  }

  /**
   * Resolve a reference name against the scope chain of `scope`, then
   * file-level symbols, then imports, then the global index.
   */
  resolve(from: DocumentModel, scope: SysmlSymbol, name: string): IndexedSymbol | undefined {
    // 1. Scope chain: innermost enclosing declaration upwards.
    let cur: SysmlSymbol | undefined = scope;
    while (cur) {
      const hit = cur.children.find((c) => c.name === name || c.shortName === name);
      if (hit) {
        return { sym: hit, model: from };
      }
      cur = cur.parent;
    }

    // 2. File-level symbols.
    const local = from.symbols.find((s) => s.name === name || s.shortName === name);
    if (local) {
      return { sym: local, model: from };
    }

    // 3. Imported namespaces / memberships (root-scope import refs).
    for (const ref of from.root.refs) {
      if (ref.kind !== 'import' || !ref.resolved) {
        continue;
      }
      const targetModel = this.docs.get(ref.resolved.uri);
      const targetSym = targetModel?.root.children.find((c) => c.qname === ref.resolved!.qname);
      if (!targetSym || !targetModel) {
        continue;
      }
      const owned = targetSym.children.find((c) => c.name === name || c.shortName === name);
      if (owned) {
        return { sym: owned, model: targetModel };
      }
      // Namespace import `import X::*;` also exposes X's own name.
      if (targetSym.name === name) {
        return { sym: targetSym, model: targetModel };
      }
    }

    // 4. Global index; prefer user files over the standard library.
    const candidates = this.lookupByName(name);
    if (candidates.length === 0) {
      return undefined;
    }
    const user = candidates.find((c) => !c.model.library);
    return user ?? candidates[0];
  }

  /** Resolve every reference of a document (diagnostics + navigation). */
  resolveRefs(model: DocumentModel): void {
    const visit = (sym: SysmlSymbol): void => {
      for (const ref of sym.refs) {
        const hit = this.resolve(model, sym, ref.name);
        ref.resolved = hit
          ? {
              name: hit.sym.name,
              kind: hit.sym.kind,
              qname: hit.sym.qname,
              uri: hit.model.uri,
              range: hit.sym.range,
              selectionRange: hit.sym.nameRange,
            }
          : undefined;
      }
      for (const c of sym.children) {
        visit(c);
      }
    };
    visit(model.root);
  }
}
