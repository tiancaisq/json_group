import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  CornerUpLeft,
  Replace,
  Search,
  X,
} from 'lucide-react';
import {
  ActiveBracketInfo,
  BracketAnalysis,
  BracketPair,
  EditMeta,
  SyntaxToken,
  ValidationResult,
} from '../types/editor';
import { offsetToLineCol } from '../utils/bracketMatcher';
import {
  applyProjectedEdit,
  computeFoldProjection,
  fullOffsetToProjected,
  projectedOffsetToFull,
  splitTokensByLine,
} from '../utils/folding';

export interface CodeEditorHandle {
  jumpToOffset: (offset: number, shouldFlash?: boolean) => void;
  selectRange: (start: number, end: number) => void;
  restoreSelection: (start: number, end: number) => void;
  jumpToMatchingBracket: () => boolean;
  selectBracketBlock: () => boolean;
  openSearch: (withReplace?: boolean) => void;
  focus: () => void;
}

interface CodeEditorProps {
  value: string;
  onChange: (nextValue: string, meta?: EditMeta) => void;
  onUndo: () => void;
  onRedo: () => void;
  analysis: BracketAnalysis;
  activeBracket: ActiveBracketInfo | null;
  enclosingPair: BracketPair | null;
  validation: ValidationResult;
  cursorOffset: number;
  selectionRange: { start: number; end: number };
  onCursorChange: (start: number, end: number) => void;
  collapsedLines: Set<number>;
  onToggleFold: (fullLine: number) => void;
  onCollapsedLinesChange: (next: Set<number>) => void;
  showFloatingHint: boolean;
  autoCloseBrackets: boolean;
  onNotify?: (message: string) => void;
}

const LINE_HEIGHT = 22;
const PADDING_TOP = 16;
const PADDING_LEFT = 16;
const VIRTUALIZE_THRESHOLD = 200;
const OVERSCAN_ROWS = 32;
const REWINDOW_MARGIN = 12;

const DEPTH_BRACKET_CLASSES = [
  'text-blue-600 dark:text-sky-400',
  'text-teal-600 dark:text-teal-400',
  'text-amber-600 dark:text-amber-400',
  'text-violet-600 dark:text-violet-400',
];

function getTokenClass(tok: SyntaxToken): string {
  switch (tok.kind) {
    case 'key':
      return 'text-blue-700 dark:text-sky-300';
    case 'string':
      return 'text-emerald-700 dark:text-emerald-300';
    case 'number':
      return 'text-amber-700 dark:text-amber-300';
    case 'boolean':
      return 'text-violet-700 dark:text-violet-300';
    case 'null':
      return 'text-rose-600 dark:text-rose-400';
    case 'comment':
      return 'text-slate-400 dark:text-slate-500 italic';
    case 'keyword':
      return 'text-indigo-700 dark:text-indigo-300';
    case 'punctuation':
      return 'text-slate-500 dark:text-slate-400';
    case 'bracket': {
      if (tok.isUnmatchedBracket) {
        return 'text-red-600 dark:text-red-400 bg-red-500/15 shadow-[inset_0_0_0_1.5px_rgba(220,38,38,0.85)] rounded-[2px]';
      }
      const depth = tok.bracketDepth ?? 0;
      return DEPTH_BRACKET_CLASSES[depth % DEPTH_BRACKET_CLASSES.length];
    }
    default:
      return 'text-slate-800 dark:text-slate-200';
  }
}

interface SearchMatch {
  start: number;
  end: number;
}

interface FoldBadgePos {
  fullLine: number;
  top: number;
  left: number;
  hiddenLineCount: number;
  closeChar: string;
}

interface PendingSelection {
  fullStart: number;
  fullEnd: number;
  shouldFlash: boolean;
  shouldScroll: boolean;
}

const CodeEditorInner = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  {
    value,
    onChange,
    onUndo,
    onRedo,
    analysis,
    activeBracket,
    enclosingPair,
    validation,
    cursorOffset,
    selectionRange,
    onCursorChange,
    collapsedLines,
    onToggleFold,
    onCollapsedLinesChange,
    showFloatingHint,
    autoCloseBrackets,
    onNotify,
  },
  ref
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLPreElement>(null);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const bgInnerRef = useRef<HTMLDivElement>(null);
  const foldOverlayRef = useRef<HTMLDivElement>(null);
  const floatingWrapRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const nextInputMetaRef = useRef<EditMeta | null>(null);

  const scrollRef = useRef({ top: 0, left: 0 });
  const activeSpanDocPosRef = useRef<{ top: number; left: number } | null>(null);
  const prevActiveElRef = useRef<HTMLElement | null>(null);
  const prevPartnerElRef = useRef<HTMLElement | null>(null);
  const flashElRef = useRef<HTMLElement | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);
  const pendingProjCaretRef = useRef<{ start: number; end: number } | null>(null);
  const lastReportedCursorRef = useRef<{ start: number; end: number }>({
    start: cursorOffset,
    end: selectionRange.end,
  });

  const [foldBadges, setFoldBadges] = useState<FoldBadgePos[]>([]);
  const [windowAnchorRow, setWindowAnchorRow] = useState(0);
  const [viewportRowsCount, setViewportRowsCount] = useState(44);

  // Search & Replace state
  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  // Code folding projection & line-split syntax tokens
  const projection = useMemo(
    () => computeFoldProjection(value, analysis, collapsedLines),
    [value, analysis, collapsedLines]
  );

  const tokensByLine = useMemo(
    () => splitTokensByLine(analysis.tokens, analysis.lineStarts.length),
    [analysis.tokens, analysis.lineStarts.length]
  );

  const totalVisibleRows = projection.visibleRows.length;
  const isVirtualized = totalVisibleRows > VIRTUALIZE_THRESHOLD;

  // Measure viewport height on resize to size virtualization window accurately
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const updateHeight = () => {
      const rows = Math.max(24, Math.ceil(el.clientHeight / LINE_HEIGHT) + 4);
      setViewportRowsCount((prev) => (Math.abs(prev - rows) >= 4 ? rows : prev));
    };
    updateHeight();
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute active render window [startRow, endRow)
  const windowRange = useMemo(() => {
    if (!isVirtualized) {
      return { startRow: 0, endRow: totalVisibleRows };
    }
    const startRow = Math.max(0, windowAnchorRow - OVERSCAN_ROWS);
    const endRow = Math.min(totalVisibleRows, windowAnchorRow + viewportRowsCount + OVERSCAN_ROWS);
    return { startRow, endRow };
  }, [isVirtualized, totalVisibleRows, windowAnchorRow, viewportRowsCount]);

  const windowRows = useMemo(
    () =>
      isVirtualized
        ? projection.visibleRows.slice(windowRange.startRow, windowRange.endRow)
        : projection.visibleRows,
    [isVirtualized, projection.visibleRows, windowRange.startRow, windowRange.endRow]
  );

  const windowOffsetY = windowRange.startRow * LINE_HEIGHT;
  const cursorLineCol = useMemo(
    () => offsetToLineCol(analysis.lineStarts, cursorOffset),
    [analysis.lineStarts, cursorOffset]
  );

  const scopePair = activeBracket?.pair ?? enclosingPair;

  // Search matches
  const searchMatches = useMemo<SearchMatch[]>(() => {
    if (!searchOpen || !searchQuery) return [];
    const matches: SearchMatch[] = [];
    const lowerText = value.toLowerCase();
    const lowerQuery = searchQuery.toLowerCase();
    let idx = 0;
    while (idx < lowerText.length) {
      const found = lowerText.indexOf(lowerQuery, idx);
      if (found === -1) break;
      matches.push({ start: found, end: found + searchQuery.length });
      idx = found + Math.max(1, searchQuery.length);
      if (matches.length >= 500) break;
    }
    return matches;
  }, [searchOpen, searchQuery, value]);

  useEffect(() => {
    if (activeMatchIdx >= searchMatches.length && searchMatches.length > 0) {
      setActiveMatchIdx(0);
    }
  }, [searchMatches.length, activeMatchIdx]);

  // Imperative 0-re-render floating button positioning
  const positionFloatingButton = useCallback(() => {
    const wrap = floatingWrapRef.current;
    const surface = surfaceRef.current;
    const docPos = activeSpanDocPosRef.current;
    if (!wrap || !surface || !docPos) {
      if (wrap) wrap.style.display = 'none';
      return;
    }

    const { top: scrollTop, left: scrollLeft } = scrollRef.current;
    const viewTop = docPos.top - scrollTop;
    const viewLeft = docPos.left - scrollLeft;
    const surfaceW = surface.clientWidth;
    const surfaceH = surface.clientHeight;

    const visible =
      viewTop >= -10 && viewTop <= surfaceH - 16 && viewLeft >= 0 && viewLeft <= surfaceW;

    if (!visible) {
      wrap.style.display = 'none';
      return;
    }

    const placeBelow = viewTop < 44;
    const finalTop = placeBelow ? viewTop + LINE_HEIGHT + 6 : viewTop - 34;
    const finalLeft = Math.max(12, Math.min(viewLeft, surfaceW - 230));
    wrap.style.display = 'block';
    wrap.style.transform = `translate3d(${finalLeft}px, ${finalTop}px, 0)`;
  }, []);

  // Imperative 0-re-render GPU scroll synchronization across all layers
  const syncScrollLayers = useCallback(
    (top: number, left: number) => {
      scrollRef.current = { top, left };
      if (gutterInnerRef.current) {
        gutterInnerRef.current.style.transform = `translate3d(0, ${-top}px, 0)`;
      }
      if (bgInnerRef.current) {
        bgInnerRef.current.style.transform = `translate3d(0, ${-top}px, 0)`;
      }
      if (mirrorRef.current) {
        mirrorRef.current.style.transform = `translate3d(${-left}px, ${-top}px, 0)`;
      }
      if (foldOverlayRef.current) {
        foldOverlayRef.current.style.transform = `translate3d(${-left}px, ${-top}px, 0)`;
      }
      positionFloatingButton();

      if (isVirtualized) {
        const firstVis = Math.floor(top / LINE_HEIGHT);
        const lastVis = firstVis + viewportRowsCount;
        if (
          firstVis < windowRange.startRow + REWINDOW_MARGIN && windowRange.startRow > 0
        ) {
          setWindowAnchorRow(firstVis);
        } else if (
          lastVis > windowRange.endRow - REWINDOW_MARGIN &&
          windowRange.endRow < totalVisibleRows
        ) {
          setWindowAnchorRow(firstVis);
        }
      }
    },
    [
      isVirtualized,
      viewportRowsCount,
      windowRange.startRow,
      windowRange.endRow,
      totalVisibleRows,
      positionFloatingButton,
    ]
  );

  // Re-apply scroll transform cleanly after window/projection changes
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      syncScrollLayers(ta.scrollTop, ta.scrollLeft);
    }
  }, [syncScrollLayers, projection]);

  const scrollVisibleRowIntoView = useCallback(
    (visibleIndex: number) => {
      const ta = textareaRef.current;
      if (!ta || visibleIndex < 0) return;
      const targetY = visibleIndex * LINE_HEIGHT + PADDING_TOP;
      const viewTop = ta.scrollTop;
      const viewHeight = ta.clientHeight;
      const margin = Math.min(viewHeight * 0.25, 110);

      if (targetY < viewTop + margin || targetY > viewTop + viewHeight - margin - LINE_HEIGHT) {
        const nextScrollTop = Math.max(0, targetY - viewHeight * 0.38);
        ta.scrollTop = nextScrollTop;
        syncScrollLayers(ta.scrollTop, ta.scrollLeft);
      }
    },
    [syncScrollLayers]
  );

  // Imperative O(1) arrival flash on target bracket span (0 React re-renders)
  const triggerFlash = useCallback((idx: number) => {
    if (flashElRef.current) {
      flashElRef.current.classList.remove('bracket-flash');
      flashElRef.current = null;
    }
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }

    requestAnimationFrame(() => {
      const mirrorEl = mirrorRef.current;
      if (!mirrorEl) return;
      const span = mirrorEl.querySelector<HTMLElement>(`[data-b="${idx}"]`);
      if (!span) return;
      span.classList.remove('bracket-flash');
      void span.offsetWidth; // restart animation cleanly
      span.classList.add('bracket-flash');
      flashElRef.current = span;
      flashTimerRef.current = window.setTimeout(() => {
        span.classList.remove('bracket-flash');
        if (flashElRef.current === span) flashElRef.current = null;
        flashTimerRef.current = null;
      }, 560);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  const emitCursorChange = useCallback(
    (start: number, end: number) => {
      const prev = lastReportedCursorRef.current;
      if (prev.start === start && prev.end === end) return;
      lastReportedCursorRef.current = { start, end };
      onCursorChange(start, end);
    },
    [onCursorChange]
  );

  // Apply deferred selection after folding/unfolding or projected edits settle
  useLayoutEffect(() => {
    if (pendingProjCaretRef.current) {
      const { start, end } = pendingProjCaretRef.current;
      pendingProjCaretRef.current = null;
      const ta = textareaRef.current;
      if (ta) {
        const clampedStart = Math.max(0, Math.min(start, projection.projectedText.length));
        const clampedEnd = Math.max(clampedStart, Math.min(end, projection.projectedText.length));
        ta.setSelectionRange(clampedStart, clampedEnd);
        const fullStart = projectedOffsetToFull(projection, clampedStart);
        const fullEnd = projectedOffsetToFull(projection, clampedEnd);
        emitCursorChange(fullStart, fullEnd);
      }
    }

    if (pendingSelectionRef.current) {
      const pending = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      const ta = textareaRef.current;
      const projStart = fullOffsetToProjected(projection, pending.fullStart);
      const projEnd = fullOffsetToProjected(projection, pending.fullEnd);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(projStart, projEnd);
      }
      emitCursorChange(pending.fullStart, pending.fullEnd);
      if (pending.shouldScroll) {
        const targetLine = offsetToLineCol(analysis.lineStarts, pending.fullStart).line;
        const vIdx = projection.fullLineToVisibleIndex.get(targetLine);
        if (vIdx !== undefined) {
          scrollVisibleRowIntoView(vIdx);
        }
      }
      if (pending.shouldFlash) {
        triggerFlash(pending.fullStart);
      }
    }
  }, [projection, analysis.lineStarts, emitCursorChange, scrollVisibleRowIntoView, triggerFlash]);

  const unfoldAncestorsForLines = useCallback(
    (lines: number[]): boolean => {
      if (collapsedLines.size === 0) return false;
      const toRemove = new Set<number>();
      for (const pair of analysis.pairs) {
        if (!collapsedLines.has(pair.openLine)) continue;
        for (const targetLine of lines) {
          if (targetLine > pair.openLine && targetLine <= pair.closeLine) {
            toRemove.add(pair.openLine);
          }
        }
      }
      if (toRemove.size === 0) return false;
      const next = new Set(collapsedLines);
      for (const l of toRemove) next.delete(l);
      onCollapsedLinesChange(next);
      return true;
    },
    [collapsedLines, analysis.pairs, onCollapsedLinesChange]
  );

  const jumpToOffset = useCallback(
    (offset: number, shouldFlash = true) => {
      const clamped = Math.max(0, Math.min(offset, value.length));
      const targetLine = offsetToLineCol(analysis.lineStarts, clamped).line;
      const didUnfold = unfoldAncestorsForLines([targetLine]);

      if (didUnfold) {
        pendingSelectionRef.current = {
          fullStart: clamped,
          fullEnd: clamped,
          shouldFlash,
          shouldScroll: true,
        };
        return;
      }

      const ta = textareaRef.current;
      const projPos = fullOffsetToProjected(projection, clamped);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(projPos, projPos);
      }
      emitCursorChange(clamped, clamped);
      const vIdx = projection.fullLineToVisibleIndex.get(targetLine);
      if (vIdx !== undefined) {
        scrollVisibleRowIntoView(vIdx);
      }
      if (shouldFlash) {
        triggerFlash(clamped);
      }
    },
    [
      value.length,
      analysis.lineStarts,
      unfoldAncestorsForLines,
      projection,
      emitCursorChange,
      scrollVisibleRowIntoView,
      triggerFlash,
    ]
  );

  const selectRange = useCallback(
    (start: number, end: number) => {
      const s = Math.max(0, Math.min(start, value.length));
      const e = Math.max(s, Math.min(end, value.length));
      const startLine = offsetToLineCol(analysis.lineStarts, s).line;
      const endLine = offsetToLineCol(analysis.lineStarts, e).line;
      const didUnfold = unfoldAncestorsForLines([startLine, endLine]);

      if (didUnfold) {
        pendingSelectionRef.current = {
          fullStart: s,
          fullEnd: e,
          shouldFlash: false,
          shouldScroll: true,
        };
        return;
      }

      const ta = textareaRef.current;
      const projStart = fullOffsetToProjected(projection, s);
      const projEnd = fullOffsetToProjected(projection, e);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(projStart, projEnd);
      }
      emitCursorChange(s, e);
      const vIdx = projection.fullLineToVisibleIndex.get(startLine);
      if (vIdx !== undefined) {
        scrollVisibleRowIntoView(vIdx);
      }
    },
    [
      value.length,
      analysis.lineStarts,
      unfoldAncestorsForLines,
      projection,
      emitCursorChange,
      scrollVisibleRowIntoView,
    ]
  );

  const jumpToMatchingBracket = useCallback((): boolean => {
    if (activeBracket) {
      if (activeBracket.partner) {
        jumpToOffset(activeBracket.partner.index, true);
        return true;
      }
      onNotify?.(
        `第 ${activeBracket.token.line} 行的 "${activeBracket.token.char}" 没有匹配的闭合括号`
      );
      return false;
    }

    if (enclosingPair) {
      jumpToOffset(enclosingPair.closeIndex, true);
      return true;
    }

    onNotify?.('当前光标不在括号或括号块内');
    return false;
  }, [activeBracket, enclosingPair, jumpToOffset, onNotify]);

  const selectBracketBlock = useCallback((): boolean => {
    const targetPair = activeBracket?.pair ?? enclosingPair;
    if (!targetPair) {
      onNotify?.('当前位置没有可选择的完整括号块');
      return false;
    }
    selectRange(targetPair.openIndex, targetPair.closeIndex + 1);
    return true;
  }, [activeBracket, enclosingPair, selectRange, onNotify]);

  const openSearch = useCallback((withReplace = false) => {
    setSearchOpen(true);
    setReplaceOpen(withReplace);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const restoreSelection = useCallback((start: number, end: number) => {
    pendingSelectionRef.current = {
      fullStart: start,
      fullEnd: end,
      shouldFlash: false,
      shouldScroll: true,
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      jumpToOffset,
      selectRange,
      restoreSelection,
      jumpToMatchingBracket,
      selectBracketBlock,
      openSearch,
      focus: () => textareaRef.current?.focus(),
    }),
    [jumpToOffset, selectRange, restoreSelection, jumpToMatchingBracket, selectBracketBlock, openSearch]
  );

  // O(1) DOM class toggle for active + partner brackets (zero React re-render of <pre>!)
  useLayoutEffect(() => {
    if (prevActiveElRef.current) {
      prevActiveElRef.current.classList.remove(
        'bracket-active-matched',
        'bracket-active-unmatched'
      );
      prevActiveElRef.current = null;
    }
    if (prevPartnerElRef.current) {
      prevPartnerElRef.current.classList.remove('bracket-partner');
      prevPartnerElRef.current = null;
    }

    const mirrorEl = mirrorRef.current;
    if (!mirrorEl || !activeBracket) {
      activeSpanDocPosRef.current = null;
      positionFloatingButton();
      return;
    }

    const activeSpan = mirrorEl.querySelector<HTMLElement>(
      `[data-b="${activeBracket.token.index}"]`
    );
    if (activeSpan) {
      activeSpan.classList.add(
        activeBracket.isMatched ? 'bracket-active-matched' : 'bracket-active-unmatched'
      );
      prevActiveElRef.current = activeSpan;

      if (showFloatingHint && activeBracket.isMatched && selectionRange.start === selectionRange.end) {
        activeSpanDocPosRef.current = {
          top: activeSpan.offsetTop,
          left: activeSpan.offsetLeft,
        };
      } else {
        activeSpanDocPosRef.current = null;
      }
    } else {
      activeSpanDocPosRef.current = null;
    }

    if (activeBracket.partner) {
      const partnerSpan = mirrorEl.querySelector<HTMLElement>(
        `[data-b="${activeBracket.partner.index}"]`
      );
      if (partnerSpan) {
        partnerSpan.classList.add('bracket-partner');
        prevPartnerElRef.current = partnerSpan;
      }
    }

    positionFloatingButton();
  }, [
    activeBracket,
    showFloatingHint,
    selectionRange.start,
    selectionRange.end,
    windowRange.startRow,
    windowRange.endRow,
    projection,
    positionFloatingButton,
  ]);

  // Measure inline fold badges in document coordinates ONLY when folds or window change (never during scroll)
  useLayoutEffect(() => {
    if (projection.activeFolds.length === 0) {
      setFoldBadges((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const mirrorEl = mirrorRef.current;
    if (!mirrorEl) return;

    const nextBadges: FoldBadgePos[] = [];
    for (const row of windowRows) {
      if (!row.foldedPair || row.hiddenLineCount <= 0) continue;
      const anchor = mirrorEl.querySelector<HTMLElement>(`[data-fold-anchor="${row.fullLine}"]`);
      if (!anchor) continue;
      nextBadges.push({
        fullLine: row.fullLine,
        top: anchor.offsetTop,
        left: anchor.offsetLeft + 8,
        hiddenLineCount: row.hiddenLineCount,
        closeChar: row.foldedPair.closeChar,
      });
    }
    setFoldBadges(nextBadges);
  }, [projection, windowRows]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLTextAreaElement>) => {
      const target = e.currentTarget;
      syncScrollLayers(target.scrollTop, target.scrollLeft);
    },
    [syncScrollLayers]
  );

  const syncSelectionFromTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const fullStart = projectedOffsetToFull(projection, ta.selectionStart);
    const fullEnd = projectedOffsetToFull(projection, ta.selectionEnd);
    emitCursorChange(fullStart, fullEnd);
  }, [projection, emitCursorChange]);

  const applyProjectedTextChange = useCallback(
    (
      nextProjectedText: string,
      nextProjStart: number,
      nextProjEnd = nextProjStart,
      meta?: EditMeta
    ) => {
      const { nextFullText, nextCollapsedLines } = applyProjectedEdit(
        value,
        projection,
        nextProjectedText,
        collapsedLines
      );
      pendingProjCaretRef.current = { start: nextProjStart, end: nextProjEnd };
      if (nextCollapsedLines !== collapsedLines) {
        onCollapsedLinesChange(nextCollapsedLines);
      }
      onChange(nextFullText, meta);
    },
    [value, projection, collapsedLines, onCollapsedLinesChange, onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const projText = projection.projectedText;

      // 0. Undo / Redo: Ctrl+Z / Cmd+Z, Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y
      const lowerKey = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && lowerKey === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          onRedo();
        } else {
          onUndo();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && lowerKey === 'y') {
        e.preventDefault();
        onRedo();
        return;
      }

      // 1. Jump to matching bracket: Ctrl+M, Ctrl+Shift+\, or Alt+]
      const isCtrlM =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && lowerKey === 'm';
      const isCtrlShiftBackslash =
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (e.key === '\\' || e.key === '|' || e.code === 'Backslash');
      const isAltRightBracket =
        e.altKey && !e.ctrlKey && !e.metaKey && (e.key === ']' || e.code === 'BracketRight');

      if (isCtrlM || isCtrlShiftBackslash || isAltRightBracket) {
        e.preventDefault();
        jumpToMatchingBracket();
        return;
      }

      // 2. Fold / Unfold current block: Ctrl+Shift+[ / Ctrl+Shift+]
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (e.key === '[' || e.key === '{' || e.code === 'BracketLeft')
      ) {
        e.preventDefault();
        const targetFoldLine = projection.foldableByLine.has(cursorLineCol.line)
          ? cursorLineCol.line
          : scopePair && scopePair.closeLine > scopePair.openLine
          ? scopePair.openLine
          : null;
        if (targetFoldLine !== null && !collapsedLines.has(targetFoldLine)) {
          onToggleFold(targetFoldLine);
          const pair = projection.foldableByLine.get(targetFoldLine);
          if (pair) {
            jumpToOffset(pair.openIndex, false);
          }
        }
        return;
      }

      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (e.key === ']' || e.key === '}' || e.code === 'BracketRight')
      ) {
        e.preventDefault();
        if (collapsedLines.has(cursorLineCol.line)) {
          onToggleFold(cursorLineCol.line);
        }
        return;
      }

      // 3. Select entire bracket block: Ctrl+Shift+M
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        selectBracketBlock();
        return;
      }

      // 4. Find / Replace: Ctrl+F / Ctrl+H
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openSearch(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        openSearch(true);
        return;
      }
      if (e.key === 'Escape' && searchOpen) {
        e.preventDefault();
        setSearchOpen(false);
        return;
      }

      // 5. Tab / Shift+Tab indentation
      if (e.key === 'Tab') {
        e.preventDefault();
        if (start === end && !e.shiftKey) {
          const next = projText.slice(0, start) + '  ' + projText.slice(end);
          applyProjectedTextChange(next, start + 2, start + 2, {
            label: '缩进调整',
            forceSnapshot: true,
          });
          return;
        }
        const lineStart = projText.lastIndexOf('\n', start - 1) + 1;
        const block = projText.slice(lineStart, end);
        const lines = block.split('\n');
        let deltaStart = 0;
        let deltaTotal = 0;
        const transformed = lines.map((line, idx) => {
          if (e.shiftKey) {
            const removed = line.startsWith('  ')
              ? 2
              : line.startsWith(' ') || line.startsWith('\t')
              ? 1
              : 0;
            if (idx === 0) deltaStart = -removed;
            deltaTotal -= removed;
            return line.slice(removed);
          } else {
            if (idx === 0) deltaStart = 2;
            deltaTotal += 2;
            return '  ' + line;
          }
        });
        const next = projText.slice(0, lineStart) + transformed.join('\n') + projText.slice(end);
        applyProjectedTextChange(
          next,
          Math.max(lineStart, start + deltaStart),
          Math.max(lineStart, end + deltaTotal),
          { label: '缩进调整', forceSnapshot: true }
        );
        return;
      }

      // 6. Smart Enter auto-indent
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const lineStart = projText.lastIndexOf('\n', start - 1) + 1;
        const currentLine = projText.slice(lineStart, start);
        const indentMatch = currentLine.match(/^[\t ]*/);
        const baseIndent = indentMatch ? indentMatch[0] : '';
        const prevChar = projText[start - 1];
        const nextChar = projText[end];

        const isOpeningBefore = prevChar === '{' || prevChar === '[' || prevChar === '(';
        const isClosingPairAfter =
          (prevChar === '{' && nextChar === '}') ||
          (prevChar === '[' && nextChar === ']') ||
          (prevChar === '(' && nextChar === ')');

        if (isClosingPairAfter) {
          const insertion = `\n${baseIndent}  \n${baseIndent}`;
          const next = projText.slice(0, start) + insertion + projText.slice(end);
          applyProjectedTextChange(
            next,
            start + 1 + baseIndent.length + 2,
            start + 1 + baseIndent.length + 2,
            { label: '换行缩进', forceSnapshot: true }
          );
          return;
        }

        const extraIndent = isOpeningBefore ? '  ' : '';
        const insertion = `\n${baseIndent}${extraIndent}`;
        const next = projText.slice(0, start) + insertion + projText.slice(end);
        applyProjectedTextChange(next, start + insertion.length, start + insertion.length, {
          label: '换行缩进',
          forceSnapshot: true,
        });
        return;
      }

      // 7. Auto-close brackets & quotes
      if (autoCloseBrackets && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const pairs: Record<string, string> = {
          '{': '}',
          '[': ']',
          '(': ')',
          '"': '"',
        };
        if (pairs[e.key]) {
          const closeChar = pairs[e.key];
          const nextChar = projText[end];
          if (start !== end) {
            e.preventDefault();
            const selected = projText.slice(start, end);
            const next =
              projText.slice(0, start) + e.key + selected + closeChar + projText.slice(end);
            applyProjectedTextChange(next, start + 1, end + 1, {
              label: '包裹括号',
              forceSnapshot: true,
            });
            return;
          }
          if (e.key === '"' && nextChar === '"') {
            e.preventDefault();
            applyProjectedTextChange(projText, start + 1);
            return;
          }
          if (!nextChar || /[\s,}\])]/u.test(nextChar)) {
            e.preventDefault();
            const next = projText.slice(0, start) + e.key + closeChar + projText.slice(end);
            applyProjectedTextChange(next, start + 1, start + 1, {
              label: '编辑文本',
            });
            return;
          }
        }

        if (
          (e.key === '}' || e.key === ']' || e.key === ')') &&
          start === end &&
          projText[start] === e.key
        ) {
          e.preventDefault();
          applyProjectedTextChange(projText, start + 1);
          return;
        }

        if (e.key === 'Backspace' && start === end && start > 0) {
          const prev = projText[start - 1];
          const next = projText[start];
          if (
            (prev === '{' && next === '}') ||
            (prev === '[' && next === ']') ||
            (prev === '(' && next === ')') ||
            (prev === '"' && next === '"')
          ) {
            e.preventDefault();
            const updated = projText.slice(0, start - 1) + projText.slice(start + 1);
            applyProjectedTextChange(updated, start - 1, start - 1, {
              label: '删除括号对',
            });
            return;
          }
        }
      }
    },
    [
      projection,
      onUndo,
      onRedo,
      cursorLineCol.line,
      scopePair,
      collapsedLines,
      onToggleFold,
      jumpToOffset,
      applyProjectedTextChange,
      autoCloseBrackets,
      jumpToMatchingBracket,
      selectBracketBlock,
      openSearch,
      searchOpen,
    ]
  );

  const gotoSearchMatch = useCallback(
    (direction: 1 | -1) => {
      if (searchMatches.length === 0) return;
      const nextIdx = (activeMatchIdx + direction + searchMatches.length) % searchMatches.length;
      setActiveMatchIdx(nextIdx);
      const match = searchMatches[nextIdx];
      selectRange(match.start, match.end);
    },
    [searchMatches, activeMatchIdx, selectRange]
  );

  const handleReplaceCurrent = useCallback(() => {
    if (searchMatches.length === 0) return;
    const match = searchMatches[activeMatchIdx] ?? searchMatches[0];
    const matchLine = offsetToLineCol(analysis.lineStarts, match.start).line;
    unfoldAncestorsForLines([matchLine]);
    const next = value.slice(0, match.start) + replaceQuery + value.slice(match.end);
    onChange(next, { label: '替换文本', forceSnapshot: true });
    pendingSelectionRef.current = {
      fullStart: match.start + replaceQuery.length,
      fullEnd: match.start + replaceQuery.length,
      shouldFlash: false,
      shouldScroll: true,
    };
  }, [
    searchMatches,
    activeMatchIdx,
    analysis.lineStarts,
    unfoldAncestorsForLines,
    value,
    replaceQuery,
    onChange,
  ]);

  const handleReplaceAll = useCallback(() => {
    if (searchMatches.length === 0 || !searchQuery) return;
    let out = '';
    let cursor = 0;
    for (const m of searchMatches) {
      out += value.slice(cursor, m.start) + replaceQuery;
      cursor = m.end;
    }
    out += value.slice(cursor);
    onChange(out, { label: `全部替换 (${searchMatches.length} 处)`, forceSnapshot: true });
    onNotify?.(`已替换 ${searchMatches.length} 处匹配项`);
  }, [searchMatches, searchQuery, value, replaceQuery, onChange, onNotify]);

  // Syntax-highlighted lines: COMPLETELY DECOUPLED from cursor movement & activeBracket!
  const renderedLines = useMemo(() => {
    const activeMatch = searchMatches[activeMatchIdx];
    const hasSearch = searchMatches.length > 0;

    const renderLineTokens = (lineTokens: SyntaxToken[]) => {
      if (!hasSearch) {
        return lineTokens.map((tok) => {
          if (tok.kind === 'plain') {
            return tok.text;
          }
          if (tok.kind === 'bracket') {
            return (
              <span key={tok.start} data-b={tok.start} className={getTokenClass(tok)}>
                {tok.text}
              </span>
            );
          }
          return (
            <span key={tok.start} className={getTokenClass(tok)}>
              {tok.text}
            </span>
          );
        });
      }

      const elements: React.ReactNode[] = [];
      for (const tok of lineTokens) {
        const baseClass = getTokenClass(tok);
        const isBracket = tok.kind === 'bracket';
        let cursor = tok.start;

        for (const m of searchMatches) {
          if (m.end <= tok.start) continue;
          if (m.start >= tok.end) break;

          const segStart = Math.max(cursor, m.start);
          const segEnd = Math.min(tok.end, m.end);

          if (segStart > cursor) {
            elements.push(
              <span
                key={`${cursor}-pre`}
                data-b={isBracket && cursor === tok.start ? tok.start : undefined}
                className={baseClass}
              >
                {value.slice(cursor, segStart)}
              </span>
            );
          }

          const isCurrentHit = activeMatch && m.start === activeMatch.start;
          elements.push(
            <span
              key={`${segStart}-hit`}
              data-b={isBracket && segStart === tok.start ? tok.start : undefined}
              className={`${baseClass} ${
                isCurrentHit
                  ? 'bg-amber-400/55 dark:bg-amber-500/45 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.9)] rounded-[2px]'
                  : 'bg-amber-300/35 dark:bg-amber-500/25 rounded-[2px]'
              }`}
            >
              {value.slice(segStart, segEnd)}
            </span>
          );
          cursor = segEnd;
        }

        if (cursor < tok.end) {
          elements.push(
            <span
              key={`${cursor}-tail`}
              data-b={isBracket && cursor === tok.start ? tok.start : undefined}
              className={baseClass}
            >
              {value.slice(cursor, tok.end)}
            </span>
          );
        }
      }
      return elements;
    };

    return windowRows.map((row, idx) => {
      const lineTokens = tokensByLine[row.fullLine - 1] ?? [];
      const isLast = idx === windowRows.length - 1;
      return (
        <React.Fragment key={row.fullLine}>
          {renderLineTokens(lineTokens)}
          {row.foldedPair && (
            <span data-fold-anchor={row.fullLine} className="inline-block w-0 h-0 align-top" />
          )}
          {!isLast ? '\n' : ''}
        </React.Fragment>
      );
    });
  }, [windowRows, tokensByLine, searchMatches, activeMatchIdx, value]);

  const visibleCursorRow = projection.fullLineToVisibleIndex.get(cursorLineCol.line) ?? -1;
  const partnerFullLine =
    activeBracket?.partner && activeBracket.partner.line !== cursorLineCol.line
      ? activeBracket.partner.line
      : null;
  const visiblePartnerRow =
    partnerFullLine !== null ? projection.fullLineToVisibleIndex.get(partnerFullLine) ?? -1 : -1;
  const visibleErrorRow =
    !validation.valid && validation.errorLine
      ? projection.fullLineToVisibleIndex.get(validation.errorLine) ?? -1
      : -1;

  return (
    <div className="relative flex-1 flex flex-col min-h-0 bg-white dark:bg-slate-950 overflow-hidden">
      {/* Inline Find & Replace Bar */}
      {searchOpen && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
          <div className="flex items-center gap-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-md px-2.5 py-1 focus-within:border-blue-500">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setActiveMatchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  gotoSearchMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === 'Escape') {
                  setSearchOpen(false);
                  textareaRef.current?.focus();
                }
              }}
              placeholder="查找内容..."
              className="w-44 sm:w-56 text-xs font-code bg-transparent outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
            />
            <span className="text-[11px] font-code tabular-nums text-slate-400 whitespace-nowrap">
              {searchQuery
                ? searchMatches.length > 0
                  ? `${activeMatchIdx + 1}/${searchMatches.length}`
                  : '0 结果'
                : ''}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => gotoSearchMatch(-1)}
              disabled={searchMatches.length === 0}
              title="上一个 (Shift+Enter)"
              className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => gotoSearchMatch(1)}
              disabled={searchMatches.length === 0}
              title="下一个 (Enter)"
              className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setReplaceOpen((v) => !v)}
              title="切换替换"
              className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${
                replaceOpen
                  ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
              }`}
            >
              <span className="inline-flex items-center gap-1">
                <Replace className="w-3.5 h-3.5" />
                替换
              </span>
            </button>
          </div>

          {replaceOpen && (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
                placeholder="替换为..."
                className="w-36 sm:w-44 text-xs font-code bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-md px-2.5 py-1 outline-none focus:border-blue-500 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
              />
              <button
                type="button"
                onClick={handleReplaceCurrent}
                disabled={searchMatches.length === 0}
                className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 whitespace-nowrap"
              >
                替换当前
              </button>
              <button
                type="button"
                onClick={handleReplaceAll}
                disabled={searchMatches.length === 0}
                className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 whitespace-nowrap"
              >
                全部替换
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              textareaRef.current?.focus();
            }}
            aria-label="关闭查找栏"
            className="ml-auto p-1 rounded text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Editor Canvas */}
      <div className="flex-1 flex min-h-0 relative overflow-hidden">
        {/* Line Number Gutter + Fold Chevrons + Vertical Bracket Scope Rail */}
        <div className="group/gutter w-[72px] shrink-0 bg-slate-50/70 dark:bg-slate-900/60 border-r border-slate-200 dark:border-slate-800 select-none overflow-hidden relative">
          <div
            ref={gutterInnerRef}
            style={{
              paddingTop: `${PADDING_TOP + windowOffsetY}px`,
              paddingBottom: '80px',
              willChange: 'transform',
            }}
          >
            {windowRows.map((row) => {
              const lineNum = row.fullLine;
              const isCurrent = lineNum === cursorLineCol.line;
              const isErrorLine = !validation.valid && validation.errorLine === lineNum;
              const isPartner = partnerFullLine === lineNum;
              const isFolded = row.foldedPair !== null;
              const canFold = row.foldablePair !== null;

              const inScope =
                scopePair !== null &&
                scopePair.openLine !== scopePair.closeLine &&
                lineNum >= scopePair.openLine &&
                lineNum <= scopePair.closeLine &&
                !isFolded;
              const isScopeStart = inScope && lineNum === scopePair!.openLine;
              const isScopeEnd = inScope && lineNum === scopePair!.closeLine;

              return (
                <div
                  key={lineNum}
                  style={{ height: `${LINE_HEIGHT}px`, lineHeight: `${LINE_HEIGHT}px` }}
                  className={`relative flex items-center justify-end pr-2.5 font-code text-[12px] tabular-nums ${
                    isErrorLine
                      ? 'text-red-600 dark:text-red-400 font-semibold bg-red-500/10'
                      : isFolded
                      ? 'text-blue-600 dark:text-sky-400 font-medium bg-blue-500/6 dark:bg-blue-400/10'
                      : isCurrent
                      ? 'text-slate-900 dark:text-slate-100 font-medium'
                      : isPartner
                      ? 'text-amber-600 dark:text-amber-400 font-medium'
                      : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => jumpToOffset(row.fullStart, false)}
                    className="flex-1 text-right pr-1 cursor-pointer outline-none"
                    title={`跳转至第 ${lineNum} 行`}
                  >
                    {lineNum}
                  </button>

                  <span className="w-[18px] h-[18px] flex items-center justify-center shrink-0">
                    {canFold && (
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onToggleFold(lineNum)}
                        aria-label={
                          isFolded
                            ? `展开第 ${lineNum} 行结构块`
                            : `收缩第 ${lineNum} 行结构块`
                        }
                        title={
                          isFolded
                            ? `展开 ${row.foldablePair!.openChar}...${row.foldablePair!.closeChar}（隐藏 ${row.hiddenLineCount} 行）`
                            : `收缩 ${row.foldablePair!.openChar}...${row.foldablePair!.closeChar}（共 ${row.foldablePair!.closeLine - row.foldablePair!.openLine + 1} 行）`
                        }
                        className={`w-[18px] h-[18px] rounded flex items-center justify-center cursor-pointer ${
                          isFolded
                            ? 'text-blue-600 dark:text-sky-400 bg-blue-500/12 hover:bg-blue-500/22 opacity-100'
                            : 'text-slate-400 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-200/80 dark:hover:bg-slate-800 opacity-55 group-hover/gutter:opacity-100'
                        }`}
                      >
                        {isFolded ? (
                          <ChevronRight className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </span>

                  {inScope && (
                    <span
                      className={`absolute right-0 w-[2.5px] ${
                        activeBracket?.isMatched
                          ? 'bg-blue-500 dark:bg-sky-400'
                          : 'bg-slate-300 dark:bg-slate-600'
                      } ${
                        isScopeStart
                          ? 'top-[5px] bottom-0 rounded-t-full'
                          : isScopeEnd
                          ? 'top-0 bottom-[5px] rounded-b-full'
                          : 'inset-y-0'
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Layered Editing Surface */}
        <div ref={surfaceRef} className="flex-1 relative min-w-0 overflow-hidden">
          {/* Layer 1: Active Line, Partner Line, Error Line & Folded Row Highlights */}
          <div aria-hidden="true" className="absolute inset-0 pointer-events-none overflow-hidden">
            <div ref={bgInnerRef} style={{ willChange: 'transform' }} className="relative w-full">
              {windowRows.map((row) =>
                row.foldedPair ? (
                  <div
                    key={`fold-bg-${row.fullLine}`}
                    style={{
                      top: `${PADDING_TOP + row.visibleIndex * LINE_HEIGHT}px`,
                      height: `${LINE_HEIGHT}px`,
                    }}
                    className="absolute inset-x-0 bg-blue-500/5 dark:bg-sky-400/6 border-b border-dashed border-blue-200/80 dark:border-sky-800/60"
                  />
                ) : null
              )}

              {visibleCursorRow >= 0 && (
                <div
                  style={{
                    top: `${PADDING_TOP + visibleCursorRow * LINE_HEIGHT}px`,
                    height: `${LINE_HEIGHT}px`,
                  }}
                  className="absolute inset-x-0 bg-slate-100/70 dark:bg-slate-800/45"
                />
              )}

              {visiblePartnerRow >= 0 && (
                <div
                  style={{
                    top: `${PADDING_TOP + visiblePartnerRow * LINE_HEIGHT}px`,
                    height: `${LINE_HEIGHT}px`,
                  }}
                  className="absolute inset-x-0 bg-amber-500/8 dark:bg-amber-400/10"
                />
              )}

              {visibleErrorRow >= 0 && (
                <div
                  style={{
                    top: `${PADDING_TOP + visibleErrorRow * LINE_HEIGHT}px`,
                    height: `${LINE_HEIGHT}px`,
                  }}
                  className="absolute inset-x-0 bg-red-500/8 dark:bg-red-500/12"
                />
              )}
            </div>
          </div>

          {/* Layer 2: Syntax-Highlighted Mirror Pre (virtualized + cursor-decoupled) */}
          <pre
            ref={mirrorRef}
            aria-hidden="true"
            style={{
              paddingTop: `${PADDING_TOP + windowOffsetY}px`,
              paddingLeft: `${PADDING_LEFT}px`,
              paddingRight: '24px',
              paddingBottom: '80px',
              willChange: 'transform',
            }}
            className="editor-layer absolute top-0 left-0 m-0 border-0 pointer-events-none select-none min-w-full"
          >
            {renderedLines}
            {'\n'}
          </pre>

          {/* Layer 3: Interactive Transparent Textarea */}
          <textarea
            ref={textareaRef}
            value={projection.projectedText}
            onPaste={() => {
              nextInputMetaRef.current = { label: '粘贴内容', forceSnapshot: true };
            }}
            onCut={() => {
              nextInputMetaRef.current = { label: '剪切内容', forceSnapshot: true };
            }}
            onChange={(e) => {
              const meta = nextInputMetaRef.current ?? { label: '编辑文本' };
              nextInputMetaRef.current = null;
              applyProjectedTextChange(
                e.target.value,
                e.target.selectionStart,
                e.target.selectionEnd,
                meta
              );
            }}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            onKeyUp={syncSelectionFromTextarea}
            onClick={syncSelectionFromTextarea}
            onSelect={syncSelectionFromTextarea}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-label="数据代码编辑区"
            style={{
              paddingTop: `${PADDING_TOP}px`,
              paddingLeft: `${PADDING_LEFT}px`,
              paddingRight: '24px',
              paddingBottom: '80px',
            }}
            className="editor-layer absolute inset-0 w-full h-full m-0 border-0 resize-none bg-transparent text-transparent caret-slate-900 dark:caret-slate-100 outline-none overflow-auto selection:bg-blue-500/22 dark:selection:bg-sky-400/25"
          />

          {/* Layer 4a: Scroll-Synced Inline Fold Expansion Badges (0 re-renders on scroll) */}
          <div
            ref={foldOverlayRef}
            style={{ willChange: 'transform' }}
            className="absolute top-0 left-0 pointer-events-none z-10"
          >
            {foldBadges.map((badge) => (
              <button
                key={`fold-badge-${badge.fullLine}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onToggleFold(badge.fullLine)}
                style={{
                  transform: `translate3d(${badge.left}px, ${badge.top + 2}px, 0)`,
                  height: '18px',
                }}
                title={`点击展开隐藏的 ${badge.hiddenLineCount} 行`}
                className="pointer-events-auto absolute top-0 left-0 inline-flex items-center gap-1 px-1.5 rounded bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-sky-700/70 text-[11px] font-code tabular-nums text-blue-700 dark:text-sky-300 hover:bg-blue-100 dark:hover:bg-blue-500/25 hover:border-blue-300 cursor-pointer whitespace-nowrap"
              >
                <span>···</span>
                <span className="opacity-80">{badge.hiddenLineCount} 行</span>
                <span className="font-semibold">{badge.closeChar}</span>
              </button>
            ))}
          </div>

          {/* Layer 4b: Contextual Floating Bracket Jump Button (positioned imperatively) */}
          <div
            ref={floatingWrapRef}
            style={{ display: 'none', willChange: 'transform' }}
            className="absolute top-0 left-0 z-20 pointer-events-auto"
          >
            {activeBracket && activeBracket.isMatched && activeBracket.partner && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  jumpToMatchingBracket();
                }}
                className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 shadow-lg shadow-slate-900/15 dark:shadow-black/40 hover:bg-blue-600 dark:hover:bg-blue-500 dark:hover:text-white text-xs font-medium whitespace-nowrap cursor-pointer"
              >
                {activeBracket.token.isOpen ? (
                  <CornerDownRight className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <CornerUpLeft className="w-3.5 h-3.5 shrink-0" />
                )}
                <span>
                  {activeBracket.token.isOpen ? '跳至右括号' : '跳至左括号'}{' '}
                  <span className="font-code font-semibold">{activeBracket.partner.char}</span>
                </span>
                <span className="text-slate-300 dark:text-slate-500 font-code text-[11px] tabular-nums">
                  行 {activeBracket.partner.line}
                </span>
                <ArrowRight className="w-3 h-3 opacity-60 shrink-0" />
                <span className="font-code text-[10px] opacity-80">Ctrl+M</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export const CodeEditor = memo(CodeEditorInner);
