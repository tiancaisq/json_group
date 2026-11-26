import {
  ActiveBracketInfo,
  ActiveStringInfo,
  BracketAnalysis,
  BracketChar,
  BracketPair,
  BracketToken,
  CloseBracketChar,
  DataFormat,
  OpenBracketChar,
  SyntaxToken,
} from '../types/editor';

const OPEN_TO_CLOSE: Record<OpenBracketChar, CloseBracketChar> = {
  '{': '}',
  '[': ']',
  '(': ')',
};

const CLOSE_TO_OPEN: Record<CloseBracketChar, OpenBracketChar> = {
  '}': '{',
  ']': '[',
  ')': '(',
};

const JS_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'return',
  'function',
  'if',
  'else',
  'for',
  'while',
  'new',
  'typeof',
  'in',
  'of',
  'and',
  'or',
  'not',
]);

export function isOpenBracket(ch: string): ch is OpenBracketChar {
  return ch === '{' || ch === '[' || ch === '(';
}

export function isCloseBracket(ch: string): ch is CloseBracketChar {
  return ch === '}' || ch === ']' || ch === ')';
}

export function buildLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

export function offsetToLineCol(
  lineStarts: number[],
  offset: number
): { line: number; col: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const lineIdx = Math.max(0, hi);
  return {
    line: lineIdx + 1,
    col: offset - lineStarts[lineIdx] + 1,
  };
}

function inferBracketLabel(text: string, openIndex: number, openChar: OpenBracketChar): string {
  // Look backwards up to 80 chars for a key or function/identifier name
  const windowStart = Math.max(0, openIndex - 80);
  const before = text.slice(windowStart, openIndex).trimEnd();

  if (!before) {
    return openChar === '{' ? '根对象' : openChar === '[' ? '根数组' : '根表达式';
  }

  // Pattern 1: "keyName": { or 'keyName': [ or keyName: {
  const keyMatch = before.match(/(?:"([^"\n]{1,40})"|'([^'\n]{1,40})'|([A-Za-z_$][\w$-]{0,39}))\s*:\s*$/);
  if (keyMatch) {
    return keyMatch[1] || keyMatch[2] || keyMatch[3] || '';
  }

  // Pattern 2: functionCall( or method(
  const fnMatch = before.match(/([A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5.]{0,39})\s*$/);
  if (fnMatch && openChar === '(') {
    return `${fnMatch[1]}()`;
  }

  // Pattern 3: Array element inside [...]
  if (before.endsWith('[') || before.endsWith(',')) {
    return openChar === '{' ? '对象元素' : openChar === '[' ? '嵌套数组' : '分组表达式';
  }

  return openChar === '{' ? '对象块' : openChar === '[' ? '数组块' : '括号表达式';
}

export function analyzeDocument(text: string, format: DataFormat): BracketAnalysis {
  const lineStarts = buildLineStarts(text);
  const tokens: SyntaxToken[] = [];
  const brackets: BracketToken[] = [];
  const bracketByIndex = new Map<number, BracketToken>();
  const pairByIndex = new Map<number, BracketPair>();
  const openStack: BracketToken[] = [];
  const pairs: BracketPair[] = [];

  const allowComments = format !== 'json';
  const allowSingleQuotes = format === 'expression';
  const allowBackticks = format === 'expression';
  const len = text.length;

  let i = 0;

  const pushToken = (
    kind: SyntaxToken['kind'],
    start: number,
    end: number,
    extra?: Partial<SyntaxToken>
  ) => {
    if (end <= start) return;
    tokens.push({
      kind,
      text: text.slice(start, end),
      start,
      end,
      ...extra,
    });
  };

  while (i < len) {
    const ch = text[i];

    // 1. Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      const start = i;
      i++;
      while (i < len) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
        else break;
      }
      pushToken('plain', start, i);
      continue;
    }

    // 2. Line comments //
    if (allowComments && ch === '/' && text[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < len && text[i] !== '\n') i++;
      pushToken('comment', start, i);
      continue;
    }

    // 3. Block comments /* ... */
    if (allowComments && ch === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i < len) i += 2;
      pushToken('comment', start, i);
      continue;
    }

    // 4. Strings: double-quoted, or single/backtick in expression mode
    if (
      ch === '"' ||
      (allowSingleQuotes && ch === "'") ||
      (allowBackticks && ch === '`')
    ) {
      const quote = ch;
      const start = i;
      i++;
      while (i < len) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        if (text[i] === '\n' && quote !== '`') {
          break;
        }
        i++;
      }

      // Determine if this string is an object key (followed by optional whitespace and ':')
      let lookAhead = i;
      while (
        lookAhead < len &&
        (text[lookAhead] === ' ' ||
          text[lookAhead] === '\t' ||
          text[lookAhead] === '\r' ||
          text[lookAhead] === '\n')
      ) {
        lookAhead++;
      }
      const isKey = text[lookAhead] === ':';
      pushToken(isKey ? 'key' : 'string', start, i);
      continue;
    }

    // 5. Brackets
    if (isOpenBracket(ch)) {
      const pos = offsetToLineCol(lineStarts, i);
      const depth = openStack.length;
      const bt: BracketToken = {
        index: i,
        char: ch,
        isOpen: true,
        depth,
        matchIndex: -1,
        line: pos.line,
        col: pos.col,
      };
      openStack.push(bt);
      brackets.push(bt);
      bracketByIndex.set(i, bt);
      pushToken('bracket', i, i + 1, { bracketDepth: depth });
      i++;
      continue;
    }

    if (isCloseBracket(ch)) {
      const pos = offsetToLineCol(lineStarts, i);
      const expectedOpen = CLOSE_TO_OPEN[ch];

      // Find nearest matching open bracket in stack
      let matchPosInStack = -1;
      for (let s = openStack.length - 1; s >= 0; s--) {
        if (openStack[s].char === expectedOpen) {
          matchPosInStack = s;
          break;
        }
      }

      if (matchPosInStack !== -1) {
        const matchedOpen = openStack[matchPosInStack];
        // Pop matched open (and any unclosed inner ones remain unmatched)
        openStack.splice(matchPosInStack);

        matchedOpen.matchIndex = i;
        const bt: BracketToken = {
          index: i,
          char: ch,
          isOpen: false,
          depth: matchedOpen.depth,
          matchIndex: matchedOpen.index,
          line: pos.line,
          col: pos.col,
        };
        brackets.push(bt);
        bracketByIndex.set(i, bt);

        const createdPair: BracketPair = {
          id: `${matchedOpen.index}-${i}`,
          openChar: matchedOpen.char as OpenBracketChar,
          closeChar: ch,
          openIndex: matchedOpen.index,
          closeIndex: i,
          openLine: matchedOpen.line,
          openCol: matchedOpen.col,
          closeLine: pos.line,
          closeCol: pos.col,
          depth: matchedOpen.depth,
          label: inferBracketLabel(text, matchedOpen.index, matchedOpen.char as OpenBracketChar),
        };
        pairs.push(createdPair);
        pairByIndex.set(matchedOpen.index, createdPair);
        pairByIndex.set(i, createdPair);

        pushToken('bracket', i, i + 1, { bracketDepth: matchedOpen.depth });
      } else {
        const bt: BracketToken = {
          index: i,
          char: ch,
          isOpen: false,
          depth: openStack.length,
          matchIndex: -1,
          line: pos.line,
          col: pos.col,
        };
        brackets.push(bt);
        bracketByIndex.set(i, bt);
        pushToken('bracket', i, i + 1, {
          bracketDepth: openStack.length,
          isUnmatchedBracket: true,
        });
      }
      i++;
      continue;
    }

    // 6. Numbers
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '-' && i + 1 < len && text[i + 1] >= '0' && text[i + 1] <= '9')
    ) {
      const start = i;
      if (ch === '-') i++;
      while (i < len && text[i] >= '0' && text[i] <= '9') i++;
      if (text[i] === '.' && text[i + 1] >= '0' && text[i + 1] <= '9') {
        i++;
        while (i < len && text[i] >= '0' && text[i] <= '9') i++;
      }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        while (i < len && text[i] >= '0' && text[i] <= '9') i++;
      }
      pushToken('number', start, i);
      continue;
    }

    // 7. Identifiers / booleans / null / keywords
    if (
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      ch === '_' ||
      ch === '$'
    ) {
      const start = i;
      i++;
      while (
        i < len &&
        ((text[i] >= 'a' && text[i] <= 'z') ||
          (text[i] >= 'A' && text[i] <= 'Z') ||
          (text[i] >= '0' && text[i] <= '9') ||
          text[i] === '_' ||
          text[i] === '$')
      ) {
        i++;
      }
      const word = text.slice(start, i);
      if (word === 'true' || word === 'false') {
        pushToken('boolean', start, i);
      } else if (word === 'null' || word === 'undefined') {
        pushToken('null', start, i);
      } else {
        // Check if unquoted key in expression mode
        let lookAhead = i;
        while (lookAhead < len && (text[lookAhead] === ' ' || text[lookAhead] === '\t')) {
          lookAhead++;
        }
        if (format === 'expression' && text[lookAhead] === ':') {
          pushToken('key', start, i);
        } else if (format === 'expression' && JS_KEYWORDS.has(word)) {
          pushToken('keyword', start, i);
        } else {
          pushToken('plain', start, i);
        }
      }
      continue;
    }

    // 8. Punctuation
    if (ch === ':' || ch === ',' || ch === ';' || ch === '.' || ch === '=' || ch === '?' || ch === '!' || ch === '>' || ch === '<' || ch === '&' || ch === '|' || ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      pushToken('punctuation', i, i + 1);
      i++;
      continue;
    }

    // 9. Any other char (including CJK outside strings)
    const start = i;
    i++;
    pushToken('plain', start, i);
  }

  // Mark any remaining unmatched open brackets on tokens
  const unmatched = brackets.filter((b) => b.matchIndex === -1);
  if (unmatched.length > 0) {
    const unmatchedSet = new Set(unmatched.map((b) => b.index));
    for (const tok of tokens) {
      if (tok.kind === 'bracket' && unmatchedSet.has(tok.start)) {
        tok.isUnmatchedBracket = true;
      }
    }
  }

  // Sort pairs in document order by openIndex
  pairs.sort((a, b) => a.openIndex - b.openIndex);

  return {
    tokens,
    brackets,
    bracketByIndex,
    pairByIndex,
    pairs,
    unmatched,
    lineStarts,
  };
}

/**
 * Detect whether the cursor is positioned at a bracket (O(1) lookup).
 */
export function findActiveBracket(
  analysis: BracketAnalysis,
  cursorPos: number
): ActiveBracketInfo | null {
  const atCursor = analysis.bracketByIndex.get(cursorPos);
  const beforeCursor = cursorPos > 0 ? analysis.bracketByIndex.get(cursorPos - 1) : undefined;

  let chosen: BracketToken | undefined;
  if (atCursor && atCursor.isOpen) {
    chosen = atCursor;
  } else if (atCursor && !atCursor.isOpen) {
    chosen = atCursor;
  } else if (beforeCursor && beforeCursor.isOpen) {
    chosen = beforeCursor;
  } else if (beforeCursor && !beforeCursor.isOpen) {
    chosen = beforeCursor;
  }

  if (!chosen) return null;

  const partner =
    chosen.matchIndex !== -1
      ? analysis.bracketByIndex.get(chosen.matchIndex) ?? null
      : null;

  const pair = partner !== null ? analysis.pairByIndex.get(chosen.index) ?? null : null;

  return {
    token: chosen,
    partner,
    pair,
    isMatched: partner !== null,
  };
}

/**
 * Find the innermost enclosing bracket pair when cursor is inside a block.
 * Pairs are sorted by openIndex so we can early-exit as soon as openIndex >= cursorPos.
 */
export function findEnclosingPair(
  analysis: BracketAnalysis,
  cursorPos: number
): BracketPair | null {
  let best: BracketPair | null = null;
  const pairs = analysis.pairs;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pair.openIndex >= cursorPos) break;
    if (cursorPos <= pair.closeIndex) {
      if (!best || pair.depth >= best.depth) {
        best = pair;
      }
    }
  }
  return best;
}

export function getExpectedPartnerChar(ch: BracketChar): BracketChar {
  if (isOpenBracket(ch)) return OPEN_TO_CLOSE[ch];
  return CLOSE_TO_OPEN[ch];
}

function hasUnescapedClosingQuote(text: string, quote: string): boolean {
  if (text.length < 2 || text[text.length - 1] !== quote) return false;
  let backslashes = 0;
  for (let k = text.length - 2; k >= 1 && text[k] === '\\'; k--) {
    backslashes++;
  }
  return backslashes % 2 === 0;
}

/**
 * Detect whether the cursor / selection is positioned inside a quoted string (or quoted key)
 * using O(log N) binary search over the sorted syntax token array.
 */
export function findActiveStringToken(
  analysis: BracketAnalysis,
  selectionStart: number,
  selectionEnd = selectionStart
): ActiveStringInfo | null {
  const tokens = analysis.tokens;
  if (tokens.length === 0) return null;

  const selStart = Math.min(selectionStart, selectionEnd);
  const selEnd = Math.max(selectionStart, selectionEnd);

  let lo = 0;
  let hi = tokens.length - 1;
  let foundIdx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid];
    if (selStart < t.start) {
      hi = mid - 1;
    } else if (selStart >= t.end) {
      lo = mid + 1;
    } else {
      foundIdx = mid;
      break;
    }
  }

  let tok: SyntaxToken | null = foundIdx !== -1 ? tokens[foundIdx] : null;
  const prevIdx = foundIdx !== -1 ? foundIdx - 1 : hi;

  // Fallback for caret positioned at the very end of an unclosed string token
  if ((!tok || (tok.kind !== 'string' && tok.kind !== 'key')) && prevIdx >= 0) {
    const prev = tokens[prevIdx];
    if (
      (prev.kind === 'string' || prev.kind === 'key') &&
      prev.end === selStart
    ) {
      tok = prev;
    }
  }

  if (!tok || (tok.kind !== 'string' && tok.kind !== 'key')) {
    return null;
  }

  const firstChar = tok.text[0];
  if (firstChar !== '"' && firstChar !== "'" && firstChar !== '`') {
    return null;
  }

  const isClosed = hasUnescapedClosingQuote(tok.text, firstChar);
  const contentStart = tok.start + 1;
  const contentEnd = isClosed ? tok.end - 1 : tok.end;

  const isInsideContent = selStart >= contentStart && selEnd <= contentEnd;
  const isExactFullToken = isClosed && selStart === tok.start && selEnd === tok.end;

  if (!isInsideContent && !isExactFullToken) {
    return null;
  }

  return {
    token: tok,
    quote: firstChar,
    isKey: tok.kind === 'key',
    isClosed,
    contentStart,
    contentEnd,
  };
}
