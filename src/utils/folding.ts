import { BracketAnalysis, BracketPair, SyntaxToken } from '../types/editor';

export interface VisibleRow {
  visibleIndex: number; // 0-based index in projected editor
  fullLine: number; // 1-based line number in full document
  fullStart: number; // start char offset in full text
  fullEnd: number; // end char offset in full text (excluding \n)
  projStart: number; // start char offset in projected text
  projEnd: number; // end char offset in projected text (excluding \n)
  foldedPair: BracketPair | null; // non-null if this row starts an actively folded block
  hiddenLineCount: number; // number of lines hidden beneath this row
  foldablePair: BracketPair | null; // outermost multi-line bracket pair starting on this line
}

export interface FoldProjection {
  visibleRows: VisibleRow[];
  projectedText: string;
  foldableByLine: Map<number, BracketPair>;
  fullLineToVisibleIndex: Map<number, number>;
  activeFolds: Array<{ openLine: number; closeLine: number; pair: BracketPair }>;
}

/**
 * Build a map of 1-based line number -> outermost multi-line BracketPair starting on that line.
 */
export function buildFoldableMap(analysis: BracketAnalysis): Map<number, BracketPair> {
  const map = new Map<number, BracketPair>();
  for (const pair of analysis.pairs) {
    if (pair.closeLine <= pair.openLine) continue;
    const existing = map.get(pair.openLine);
    if (!existing || pair.closeLine > existing.closeLine) {
      map.set(pair.openLine, pair);
    }
  }
  return map;
}

/**
 * Split syntax tokens strictly along newline boundaries so each 1-based line
 * has its own exact array of tokens (preserving multi-line comments & whitespace).
 */
export function splitTokensByLine(
  tokens: SyntaxToken[],
  lineCount: number
): SyntaxToken[][] {
  const lines: SyntaxToken[][] = Array.from({ length: Math.max(1, lineCount) }, () => []);
  let lineIdx = 0;

  for (const tok of tokens) {
    if (!tok.text.includes('\n')) {
      if (lineIdx < lines.length) {
        lines[lineIdx].push(tok);
      }
      continue;
    }

    const parts = tok.text.split('\n');
    let offset = tok.start;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (part.length > 0 && lineIdx < lines.length) {
        lines[lineIdx].push({
          ...tok,
          text: part,
          start: offset,
          end: offset + part.length,
        });
      }
      offset += part.length;
      if (p < parts.length - 1) {
        offset += 1; // newline char
        lineIdx++;
      }
    }
  }

  return lines;
}

/**
 * Compute the projected visible lines and bidirectional offset maps given active collapsed lines.
 */
export function computeFoldProjection(
  fullText: string,
  analysis: BracketAnalysis,
  collapsedLines: Set<number>
): FoldProjection {
  const foldableByLine = buildFoldableMap(analysis);
  const lineStarts = analysis.lineStarts;
  const lineCount = lineStarts.length;

  const visibleRows: VisibleRow[] = [];
  const fullLineToVisibleIndex = new Map<number, number>();
  const activeFolds: Array<{ openLine: number; closeLine: number; pair: BracketPair }> = [];
  const projectedChunks: string[] = [];

  let projOffset = 0;
  let fullLine = 1;

  while (fullLine <= lineCount) {
    const lineIdx = fullLine - 1;
    const fullStart = lineStarts[lineIdx];
    const fullEnd =
      lineIdx + 1 < lineCount ? lineStarts[lineIdx + 1] - 1 : fullText.length;
    const lineText = fullText.slice(fullStart, fullEnd);

    const foldablePair = foldableByLine.get(fullLine) ?? null;
    const isCollapsed = foldablePair !== null && collapsedLines.has(fullLine);

    const visibleIndex = visibleRows.length;
    const projStart = projOffset;
    const projEnd = projStart + lineText.length;

    let hiddenLineCount = 0;
    if (isCollapsed && foldablePair) {
      const clampedCloseLine = Math.min(foldablePair.closeLine, lineCount);
      hiddenLineCount = Math.max(0, clampedCloseLine - fullLine);
      if (hiddenLineCount > 0) {
        activeFolds.push({
          openLine: fullLine,
          closeLine: clampedCloseLine,
          pair: foldablePair,
        });
      }
    }

    visibleRows.push({
      visibleIndex,
      fullLine,
      fullStart,
      fullEnd,
      projStart,
      projEnd,
      foldedPair: isCollapsed && hiddenLineCount > 0 ? foldablePair : null,
      hiddenLineCount,
      foldablePair,
    });

    fullLineToVisibleIndex.set(fullLine, visibleIndex);
    projectedChunks.push(lineText);
    projOffset = projEnd + 1; // +1 for joining '\n'

    fullLine += 1 + hiddenLineCount;
  }

  return {
    visibleRows,
    projectedText: projectedChunks.join('\n'),
    foldableByLine,
    fullLineToVisibleIndex,
    activeFolds,
  };
}

/**
 * Map a character offset in the projected <textarea> back to the exact full-document offset.
 */
export function projectedOffsetToFull(
  projection: FoldProjection,
  projOffset: number
): number {
  const rows = projection.visibleRows;
  if (rows.length === 0) return 0;

  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].projStart <= projOffset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const row = rows[Math.max(0, hi)];
  const colDelta = Math.max(0, Math.min(projOffset - row.projStart, row.fullEnd - row.fullStart));
  return row.fullStart + colDelta;
}

/**
 * Map a character offset in the full document to its offset in the projected <textarea>.
 * If the offset lies inside a hidden folded block, clamps to the end of its folded header row.
 */
export function fullOffsetToProjected(
  projection: FoldProjection,
  fullOffset: number
): number {
  const rows = projection.visibleRows;
  if (rows.length === 0) return 0;

  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].fullStart <= fullOffset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const row = rows[Math.max(0, hi)];
  if (fullOffset <= row.fullEnd) {
    return row.projStart + Math.max(0, fullOffset - row.fullStart);
  }
  return row.projEnd;
}

/**
 * Return any collapsed lines that currently hide the given 1-based full line.
 */
export function findCollapsedAncestorsForLine(
  projection: FoldProjection,
  fullLine: number
): number[] {
  const toUnfold: number[] = [];
  for (const fold of projection.activeFolds) {
    if (fullLine > fold.openLine && fullLine <= fold.closeLine) {
      toUnfold.push(fold.openLine);
    }
  }
  return toUnfold;
}

/**
 * Reconstruct the full document text and updated collapsedLines when the user edits
 * the projected <textarea> text while one or more blocks are folded.
 * Preserves all hidden folded lines without data loss.
 */
export function applyProjectedEdit(
  fullText: string,
  projection: FoldProjection,
  nextProjectedText: string,
  prevCollapsedLines: Set<number>
): { nextFullText: string; nextCollapsedLines: Set<number> } {
  if (projection.activeFolds.length === 0) {
    return { nextFullText: nextProjectedText, nextCollapsedLines: prevCollapsedLines };
  }

  const fullLines = fullText.split('\n');
  const prevVisibleLines = projection.projectedText.split('\n');
  const nextVisibleLines = nextProjectedText.split('\n');

  let prefix = 0;
  const minLen = Math.min(prevVisibleLines.length, nextVisibleLines.length);
  while (prefix < minLen && prevVisibleLines[prefix] === nextVisibleLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    prevVisibleLines[prevVisibleLines.length - 1 - suffix] ===
      nextVisibleLines[nextVisibleLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldEditEnd = prevVisibleLines.length - suffix;
  const newEditEnd = nextVisibleLines.length - suffix;

  const emittedLines: string[] = [];
  const nextCollapsed = new Set<number>();

  // Helper: copy any nested collapsed lines inside a hidden block with an exact line delta
  const preserveCollapsedRange = (oldStartLine1: number, oldEndLine1: number, newStartLine1: number) => {
    const delta = newStartLine1 - oldStartLine1;
    for (const cLine of prevCollapsedLines) {
      if (cLine >= oldStartLine1 && cLine <= oldEndLine1) {
        nextCollapsed.add(cLine + delta);
      }
    }
  };

  // 1. Emit unchanged prefix visible rows + their hidden folded lines
  for (let v = 0; v < prefix; v++) {
    const row = projection.visibleRows[v];
    const newLine1 = emittedLines.length + 1;
    emittedLines.push(prevVisibleLines[v]);
    if (row.hiddenLineCount > 0) {
      preserveCollapsedRange(row.fullLine, row.fullLine + row.hiddenLineCount, newLine1);
      const hiddenStart0 = row.fullLine; // 0-based index of (fullLine + 1)
      const hiddenEnd0 = hiddenStart0 + row.hiddenLineCount;
      for (let h = hiddenStart0; h < hiddenEnd0 && h < fullLines.length; h++) {
        emittedLines.push(fullLines[h]);
      }
    }
  }

  // 2. Emit edited middle lines; if any folded rows overlapped the edited region,
  // re-attach their hidden lines safely (and auto-unfold so hidden data is never silently deleted).
  const editedRowsHidden: string[] = [];
  let singleModifiedFoldRow: VisibleRow | null = null;
  if (oldEditEnd - prefix === 1 && newEditEnd - prefix === 1) {
    const candidate = projection.visibleRows[prefix];
    if (candidate && candidate.hiddenLineCount > 0) {
      singleModifiedFoldRow = candidate;
    }
  }

  for (let v = prefix; v < oldEditEnd; v++) {
    const row = projection.visibleRows[v];
    if (row && row.hiddenLineCount > 0) {
      const hiddenStart0 = row.fullLine;
      const hiddenEnd0 = hiddenStart0 + row.hiddenLineCount;
      for (let h = hiddenStart0; h < hiddenEnd0 && h < fullLines.length; h++) {
        editedRowsHidden.push(fullLines[h]);
      }
    }
  }

  const editStartNewLine1 = emittedLines.length + 1;
  for (let n = prefix; n < newEditEnd; n++) {
    emittedLines.push(nextVisibleLines[n]);
  }

  if (editedRowsHidden.length > 0) {
    // If user simply edited text on the single folded header line and kept its opening bracket, keep it folded
    if (
      singleModifiedFoldRow &&
      singleModifiedFoldRow.foldedPair &&
      nextVisibleLines[prefix]?.includes(singleModifiedFoldRow.foldedPair.openChar)
    ) {
      preserveCollapsedRange(
        singleModifiedFoldRow.fullLine,
        singleModifiedFoldRow.fullLine + singleModifiedFoldRow.hiddenLineCount,
        editStartNewLine1
      );
    }
    for (const hLine of editedRowsHidden) {
      emittedLines.push(hLine);
    }
  }

  // 3. Emit unchanged suffix visible rows + their hidden folded lines
  for (let v = oldEditEnd; v < prevVisibleLines.length; v++) {
    const row = projection.visibleRows[v];
    const newLine1 = emittedLines.length + 1;
    emittedLines.push(prevVisibleLines[v]);
    if (row.hiddenLineCount > 0) {
      preserveCollapsedRange(row.fullLine, row.fullLine + row.hiddenLineCount, newLine1);
      const hiddenStart0 = row.fullLine;
      const hiddenEnd0 = hiddenStart0 + row.hiddenLineCount;
      for (let h = hiddenStart0; h < hiddenEnd0 && h < fullLines.length; h++) {
        emittedLines.push(fullLines[h]);
      }
    }
  }

  return {
    nextFullText: emittedLines.join('\n'),
    nextCollapsedLines: nextCollapsed,
  };
}
