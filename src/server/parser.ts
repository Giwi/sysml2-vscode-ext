import { BailErrorStrategy, CharStreams, CommonTokenStream, ErrorListener, PredictionMode } from 'antlr4';
import type { RecognitionException, Recognizer } from 'antlr4';
import SysMLv2Lexer from './generated/SysMLv2Lexer.js';
import SysMLv2Parser from './generated/SysMLv2Parser.js';
import type { ParserRuleContext } from 'antlr4';

export interface SyntaxErrorInfo {
  /** 0-based line. */
  line: number;
  /** 0-based character offset. */
  column: number;
  message: string;
}

export interface ParseResult {
  tree: ParserRuleContext;
  errors: SyntaxErrorInfo[];
}

class CollectingErrorListener extends ErrorListener<unknown> {
  readonly errors: SyntaxErrorInfo[] = [];

  syntaxError(
    _recognizer: Recognizer<unknown>,
    _offendingSymbol: unknown,
    line: number,
    column: number,
    msg: string,
    _e: RecognitionException | undefined
  ): void {
    this.errors.push({ line: line - 1, column, message: msg });
  }
}

function parseWith(text: string, fast: boolean): ParseResult {
  const listener = new CollectingErrorListener();

  const lexer = new SysMLv2Lexer(CharStreams.fromString(text));
  lexer.removeErrorListeners();
  lexer.addErrorListener(listener);

  const tokens = new CommonTokenStream(lexer);
  const parser = new SysMLv2Parser(tokens);
  parser.removeErrorListeners();

  if (fast) {
    // SLL + bail: much faster, used for bulk indexing (standard library).
    // The JS runtime exposes the error handler / prediction mode as fields.
    const p = parser as unknown as {
      _errHandler: unknown;
      _interp: { predictionMode: number };
    };
    p._errHandler = new BailErrorStrategy();
    p._interp.predictionMode = PredictionMode.SLL;
  } else {
    parser.addErrorListener(listener);
  }

  const tree = parser.rootNamespace();
  return { tree, errors: listener.errors };
}

/**
 * Parse SysML/KerML text, returning the parse tree and collected syntax errors.
 * `fast` uses SLL prediction with bail-out (no diagnostics); it falls back to
 * the full LL parse when prediction fails.
 */
export function parseText(text: string, fast = false): ParseResult {
  if (fast) {
    try {
      return parseWith(text, true);
    } catch {
      // fall through to full parse
    }
  }
  return parseWith(text, false);
}

export function ruleName(ctx: ParserRuleContext): string {
  return SysMLv2Parser.ruleNames[(ctx as unknown as { ruleIndex: number }).ruleIndex];
}
