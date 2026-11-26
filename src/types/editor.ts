export type DataFormat = 'json' | 'jsonc' | 'expression';

export interface DataDocument {
  id: string;
  name: string;
  format: DataFormat;
  content: string;
  updatedAt: number;
  isSample?: boolean;
}

export type OpenBracketChar = '{' | '[' | '(';
export type CloseBracketChar = '}' | ']' | ')';
export type BracketChar = OpenBracketChar | CloseBracketChar;

export interface BracketToken {
  index: number;
  char: BracketChar;
  isOpen: boolean;
  depth: number;
  matchIndex: number; // -1 if unmatched
  line: number; // 1-based
  col: number; // 1-based
}

export interface BracketPair {
  id: string;
  openChar: OpenBracketChar;
  closeChar: CloseBracketChar;
  openIndex: number;
  closeIndex: number;
  openLine: number;
  openCol: number;
  closeLine: number;
  closeCol: number;
  depth: number;
  label: string;
}

export type TokenKind =
  | 'plain'
  | 'key'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'comment'
  | 'bracket'
  | 'punctuation'
  | 'keyword';

export interface SyntaxToken {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  bracketDepth?: number;
  isUnmatchedBracket?: boolean;
}

export interface ActiveBracketInfo {
  token: BracketToken;
  partner: BracketToken | null;
  pair: BracketPair | null;
  isMatched: boolean;
}

export interface ActiveStringInfo {
  token: SyntaxToken;
  quote: '"' | "'" | '`';
  isKey: boolean;
  isClosed: boolean;
  contentStart: number;
  contentEnd: number;
}

export interface BracketAnalysis {
  tokens: SyntaxToken[];
  brackets: BracketToken[];
  bracketByIndex: Map<number, BracketToken>;
  pairByIndex: Map<number, BracketPair>;
  pairs: BracketPair[];
  unmatched: BracketToken[];
  lineStarts: number[];
}

export interface ValidationResult {
  valid: boolean;
  message: string;
  errorLine?: number;
  errorCol?: number;
  errorOffset?: number;
  parsedValue?: unknown;
}

export interface StructureNode {
  id: string;
  key: string;
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  preview: string;
  keyOffset?: number;
  offset: number;
  endOffset: number;
  line: number;
  endLine: number;
  depth: number;
  childCount: number;
  children?: StructureNode[];
}

export interface HistorySnapshot {
  id: string;
  content: string;
  cursorStart: number;
  cursorEnd: number;
  label: string;
  timestamp: number;
}

export interface EditMeta {
  label?: string;
  forceSnapshot?: boolean;
}

