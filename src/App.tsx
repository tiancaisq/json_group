import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  AlignLeft,
  ArrowDownAZ,
  Brackets,
  Check,
  CheckCircle2,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  CornerDownRight,
  CornerUpLeft,
  Download,
  Filter,
  LocateFixed,
  Minimize2,
  Moon,
  MousePointerClick,
  PanelLeft,
  PanelRight,
  Redo2,
  Search,
  Sun,
  TextSelect,
  Undo2,
} from 'lucide-react';
import { CodeEditor, CodeEditorHandle } from './components/CodeEditor';
import { HistoryMenu } from './components/HistoryMenu';
import {
  InspectorPanel,
  InspectorTab,
  LocateTreeRequest,
} from './components/InspectorPanel';
import { Sidebar } from './components/Sidebar';
import { SAMPLE_DOCUMENTS } from './data/samples';
import { DataDocument, DataFormat, EditMeta, HistorySnapshot } from './types/editor';
import {
  analyzeDocument,
  findActiveBracket,
  findActiveStringToken,
  findEnclosingPair,
  offsetToLineCol,
} from './utils/bracketMatcher';
import {
  buildStructureTree,
  findStructureNodeAtOffset,
  formatJsonText,
  minifyJsonText,
  sortJsonKeysText,
  validateData,
} from './utils/dataParser';

const STORAGE_KEY = 'shugou_editor_documents_v1';
const THEME_KEY = 'shugou_editor_theme_v1';
const MAX_HISTORY_STEPS = 80;

interface HistoryEntry {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
}

function loadInitialDocuments(): DataDocument[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Fallback to built-in samples
  }
  return SAMPLE_DOCUMENTS;
}

function getInitialCursorForDoc(content: string): number {
  // Place initial cursor on the opening '{' of "customer" or first nested '{' so bracket matching is immediately visible
  const customerIdx = content.indexOf('"customer": {');
  if (customerIdx !== -1) {
    return content.indexOf('{', customerIdx);
  }
  const firstOpen = content.search(/[{[(]/);
  return firstOpen !== -1 ? firstOpen : 0;
}

function formatByteSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function App() {
  const [documents, setDocuments] = useState<DataDocument[]>(loadInitialDocuments);
  const [activeDocId, setActiveDocId] = useState<string>(() => loadInitialDocuments()[0].id);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'dark') return true;
      if (saved === 'light') return false;
    } catch {
      // ignore
    }
    return false;
  });

  const [showSidebar, setShowSidebar] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : true)
  );
  const [showInspector, setShowInspector] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth >= 768 : true)
  );
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('brackets');
  const [locateRequest, setLocateRequest] = useState<LocateTreeRequest | null>(null);
  const [showFloatingHint, setShowFloatingHint] = useState(true);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const editorRef = useRef<CodeEditorHandle>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lastHistoryPushRef = useRef<number>(0);
  const lastHistoryLabelRef = useRef<string>('');
  const historySeqRef = useRef<number>(0);
  const locateSeqRef = useRef<number>(0);

  // Per-document undo/redo history & collapsed block lines
  const [historyMap, setHistoryMap] = useState<Record<string, HistoryEntry>>({});
  const [collapsedMap, setCollapsedMap] = useState<Record<string, number[]>>({});

  const activeDoc = useMemo(
    () => documents.find((d) => d.id === activeDocId) ?? documents[0],
    [documents, activeDocId]
  );

  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number }>(() => {
    const initial = getInitialCursorForDoc(activeDoc.content);
    return { start: initial, end: initial };
  });

  // Sync dark mode class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    try {
      localStorage.setItem(THEME_KEY, darkMode ? 'dark' : 'light');
    } catch {
      // ignore
    }
  }, [darkMode]);

  // Debounced persistence to localStorage (avoids blocking main thread on every keystroke)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
      } catch {
        // ignore quota issues
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [documents]);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2400);
  }, []);

  // Core document analysis (keeps bracket matching & editor instant)
  const analysis = useMemo(
    () => analyzeDocument(activeDoc.content, activeDoc.format),
    [activeDoc.content, activeDoc.format]
  );

  // Defer secondary heavy computations (JSON.parse validation, structure tree, byte size, InspectorPanel)
  const deferredContent = useDeferredValue(activeDoc.content);
  const deferredAnalysis = useDeferredValue(analysis);

  const activeBracket = useMemo(
    () => findActiveBracket(analysis, selectionRange.start),
    [analysis, selectionRange.start]
  );

  const activeString = useMemo(
    () => findActiveStringToken(analysis, selectionRange.start, selectionRange.end),
    [analysis, selectionRange.start, selectionRange.end]
  );

  const enclosingPair = useMemo(
    () => findEnclosingPair(analysis, selectionRange.start),
    [analysis, selectionRange.start]
  );

  const validation = useMemo(
    () => validateData(deferredContent, activeDoc.format, deferredAnalysis),
    [deferredContent, activeDoc.format, deferredAnalysis]
  );

  const structureTree = useMemo(() => {
    if (!validation.valid || activeDoc.format === 'expression') return [];
    return buildStructureTree(deferredContent, activeDoc.format, deferredAnalysis.lineStarts);
  }, [validation.valid, deferredContent, activeDoc.format, deferredAnalysis.lineStarts]);

  const formattedByteSize = useMemo(
    () => formatByteSize(deferredContent),
    [deferredContent]
  );

  const cursorLineCol = useMemo(
    () => offsetToLineCol(analysis.lineStarts, selectionRange.start),
    [analysis.lineStarts, selectionRange.start]
  );

  const currentHistory = historyMap[activeDoc.id] ?? { past: [], future: [] };

  const collapsedLines = useMemo(
    () => new Set<number>(collapsedMap[activeDoc.id] ?? []),
    [collapsedMap, activeDoc.id]
  );

  const handleCollapsedLinesChange = useCallback(
    (next: Set<number>) => {
      setCollapsedMap((prev) => ({
        ...prev,
        [activeDoc.id]: Array.from(next),
      }));
    },
    [activeDoc.id]
  );

  const handleToggleFold = useCallback(
    (fullLine: number) => {
      const isCurrentlyCollapsed = collapsedLines.has(fullLine);
      setCollapsedMap((prev) => {
        const current = new Set(prev[activeDoc.id] ?? []);
        if (current.has(fullLine)) {
          current.delete(fullLine);
        } else {
          current.add(fullLine);
        }
        return {
          ...prev,
          [activeDoc.id]: Array.from(current),
        };
      });

      if (!isCurrentlyCollapsed) {
        const pair = analysis.pairs.find(
          (p) => p.openLine === fullLine && p.closeLine > p.openLine
        );
        if (pair && cursorLineCol.line > pair.openLine && cursorLineCol.line <= pair.closeLine) {
          setSelectionRange({ start: pair.openIndex, end: pair.openIndex });
        }
      }
    },
    [activeDoc.id, collapsedLines, analysis.pairs, cursorLineCol.line]
  );

  const clearActiveFolds = useCallback(() => {
    setCollapsedMap((prev) => {
      if (!prev[activeDoc.id]?.length) return prev;
      return { ...prev, [activeDoc.id]: [] };
    });
  }, [activeDoc.id]);

  const handleFoldAll = useCallback(() => {
    const multiLinePairs = analysis.pairs.filter((p) => p.closeLine > p.openLine);
    if (multiLinePairs.length === 0) {
      notify('当前文档暂无可收缩的多行结构块');
      return;
    }
    const rootPairs = multiLinePairs.filter((p) => p.depth === 0);
    const levelOnePairs = multiLinePairs.filter((p) => p.depth === 1);
    const targetPairs =
      rootPairs.length === 1 && levelOnePairs.length > 0 ? levelOnePairs : rootPairs;

    const lines = new Set<number>(targetPairs.map((p) => p.openLine));
    handleCollapsedLinesChange(lines);
    notify(`已收缩 ${lines.size} 个结构块`);
  }, [analysis.pairs, handleCollapsedLinesChange, notify]);

  const handleUnfoldAll = useCallback(() => {
    if (collapsedLines.size === 0) return;
    clearActiveFolds();
    notify('已展开全部结构块');
  }, [collapsedLines.size, clearActiveFolds, notify]);

  const updateActiveContent = useCallback(
    (nextContent: string, recordHistory = true, meta?: EditMeta) => {
      if (nextContent === activeDoc.content) return;
      if (recordHistory) {
        const now = Date.now();
        const label = meta?.label ?? '编辑文本';
        const forceSnapshot = Boolean(meta?.forceSnapshot);
        const existingEntry = historyMap[activeDoc.id];
        const hasPast = Boolean(existingEntry && existingEntry.past.length > 0);
        const shouldPush =
          forceSnapshot ||
          !hasPast ||
          now - lastHistoryPushRef.current > 650 ||
          lastHistoryLabelRef.current !== label;

        lastHistoryPushRef.current = now;
        lastHistoryLabelRef.current = label;

        if (shouldPush) {
          const snapshot: HistorySnapshot = {
            id: `snap-${++historySeqRef.current}`,
            content: activeDoc.content,
            cursorStart: selectionRange.start,
            cursorEnd: selectionRange.end,
            label,
            timestamp: now,
          };
          setHistoryMap((prev) => {
            const entry = prev[activeDoc.id] ?? { past: [], future: [] };
            const nextPast = [...entry.past.slice(-(MAX_HISTORY_STEPS - 1)), snapshot];
            return {
              ...prev,
              [activeDoc.id]: { past: nextPast, future: [] },
            };
          });
        } else {
          // Still clear redo branch when continuing to type after an undo
          setHistoryMap((prev) => {
            const entry = prev[activeDoc.id];
            if (!entry || entry.future.length === 0) return prev;
            return {
              ...prev,
              [activeDoc.id]: { ...entry, future: [] },
            };
          });
        }
      }
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === activeDoc.id ? { ...d, content: nextContent, updatedAt: Date.now() } : d
        )
      );
    },
    [activeDoc.id, activeDoc.content, historyMap, selectionRange.start, selectionRange.end]
  );

  const handleEditorChange = useCallback(
    (val: string, meta?: EditMeta) => updateActiveContent(val, true, meta),
    [updateActiveContent]
  );

  const handleCursorChange = useCallback((start: number, end: number) => {
    setSelectionRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  const handleInspectorJump = useCallback((offset: number) => {
    editorRef.current?.jumpToOffset(offset, true);
  }, []);

  const handleInspectorSelect = useCallback((start: number, end: number) => {
    editorRef.current?.selectRange(start, end);
  }, []);

  const applyRestoredSnapshot = useCallback(
    (target: HistorySnapshot) => {
      lastHistoryPushRef.current = 0;
      clearActiveFolds();
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === activeDoc.id ? { ...d, content: target.content, updatedAt: Date.now() } : d
        )
      );
      const clampedStart = Math.max(0, Math.min(target.cursorStart, target.content.length));
      const clampedEnd = Math.max(clampedStart, Math.min(target.cursorEnd, target.content.length));
      setSelectionRange({ start: clampedStart, end: clampedEnd });
      editorRef.current?.restoreSelection(clampedStart, clampedEnd);
    },
    [activeDoc.id, clearActiveFolds]
  );

  const handleUndo = useCallback(() => {
    const entry = historyMap[activeDoc.id];
    if (!entry || entry.past.length === 0) return;
    const target = entry.past[entry.past.length - 1];
    const currentSnapshot: HistorySnapshot = {
      id: `snap-${++historySeqRef.current}`,
      content: activeDoc.content,
      cursorStart: selectionRange.start,
      cursorEnd: selectionRange.end,
      label: target.label,
      timestamp: Date.now(),
    };
    setHistoryMap((prev) => ({
      ...prev,
      [activeDoc.id]: {
        past: entry.past.slice(0, -1),
        future: [currentSnapshot, ...entry.future.slice(0, MAX_HISTORY_STEPS - 1)],
      },
    }));
    applyRestoredSnapshot(target);
    notify(`已撤销：${target.label}`);
  }, [
    activeDoc.id,
    activeDoc.content,
    historyMap,
    selectionRange.start,
    selectionRange.end,
    applyRestoredSnapshot,
    notify,
  ]);

  const handleRedo = useCallback(() => {
    const entry = historyMap[activeDoc.id];
    if (!entry || entry.future.length === 0) return;
    const target = entry.future[0];
    const currentSnapshot: HistorySnapshot = {
      id: `snap-${++historySeqRef.current}`,
      content: activeDoc.content,
      cursorStart: selectionRange.start,
      cursorEnd: selectionRange.end,
      label: target.label,
      timestamp: Date.now(),
    };
    setHistoryMap((prev) => ({
      ...prev,
      [activeDoc.id]: {
        past: [...entry.past.slice(-(MAX_HISTORY_STEPS - 1)), currentSnapshot],
        future: entry.future.slice(1),
      },
    }));
    applyRestoredSnapshot(target);
    notify(`已重做：${target.label}`);
  }, [
    activeDoc.id,
    activeDoc.content,
    historyMap,
    selectionRange.start,
    selectionRange.end,
    applyRestoredSnapshot,
    notify,
  ]);

  const handleRollbackToPastIndex = useCallback(
    (pastIndex: number) => {
      const entry = historyMap[activeDoc.id];
      if (!entry || pastIndex < 0 || pastIndex >= entry.past.length) return;
      const target = entry.past[pastIndex];
      const currentSnapshot: HistorySnapshot = {
        id: `snap-${++historySeqRef.current}`,
        content: activeDoc.content,
        cursorStart: selectionRange.start,
        cursorEnd: selectionRange.end,
        label: '回退前状态',
        timestamp: Date.now(),
      };
      const steppedCount = entry.past.length - pastIndex;
      const nextPast = entry.past.slice(0, pastIndex);
      const nextFuture = [
        ...entry.past.slice(pastIndex + 1),
        currentSnapshot,
        ...entry.future,
      ].slice(0, MAX_HISTORY_STEPS);

      setHistoryMap((prev) => ({
        ...prev,
        [activeDoc.id]: { past: nextPast, future: nextFuture },
      }));
      applyRestoredSnapshot(target);
      notify(pastIndex === 0 ? '已回退至初始状态' : `已回退 ${steppedCount} 步`);
    },
    [
      activeDoc.id,
      activeDoc.content,
      historyMap,
      selectionRange.start,
      selectionRange.end,
      applyRestoredSnapshot,
      notify,
    ]
  );

  const handleAdvanceToFutureIndex = useCallback(
    (futureIndex: number) => {
      const entry = historyMap[activeDoc.id];
      if (!entry || futureIndex < 0 || futureIndex >= entry.future.length) return;
      const target = entry.future[futureIndex];
      const currentSnapshot: HistorySnapshot = {
        id: `snap-${++historySeqRef.current}`,
        content: activeDoc.content,
        cursorStart: selectionRange.start,
        cursorEnd: selectionRange.end,
        label: target.label,
        timestamp: Date.now(),
      };
      const nextPast = [
        ...entry.past,
        currentSnapshot,
        ...entry.future.slice(0, futureIndex),
      ].slice(-MAX_HISTORY_STEPS);
      const nextFuture = entry.future.slice(futureIndex + 1);

      setHistoryMap((prev) => ({
        ...prev,
        [activeDoc.id]: { past: nextPast, future: nextFuture },
      }));
      applyRestoredSnapshot(target);
      notify(`已重做前进 ${futureIndex + 1} 步`);
    },
    [
      activeDoc.id,
      activeDoc.content,
      historyMap,
      selectionRange.start,
      selectionRange.end,
      applyRestoredSnapshot,
      notify,
    ]
  );

  // Global keyboard shortcuts (Ctrl+M / Ctrl+Shift+\ / Alt+] fallback & Undo/Redo when outside textarea)
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = target?.tagName === 'INPUT';
      if (isInput) return;

      if (target?.tagName !== 'TEXTAREA') {
        const isCtrlM =
          (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm';
        const isCtrlShiftBackslash =
          (e.ctrlKey || e.metaKey) &&
          e.shiftKey &&
          (e.key === '\\' || e.key === '|' || e.code === 'Backslash');
        const isAltRightBracket =
          e.altKey && !e.ctrlKey && !e.metaKey && (e.key === ']' || e.code === 'BracketRight');

        if (isCtrlM || isCtrlShiftBackslash || isAltRightBracket) {
          e.preventDefault();
          editorRef.current?.jumpToMatchingBracket();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
          e.preventDefault();
          editorRef.current?.selectBracketBlock();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          editorRef.current?.openSearch(false);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          handleUndo();
          return;
        }
        if (
          ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') ||
          ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y')
        ) {
          e.preventDefault();
          handleRedo();
        }
      }
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [handleUndo, handleRedo]);

  // Document switching
  const handleSelectDoc = useCallback(
    (id: string) => {
      const doc = documents.find((d) => d.id === id);
      if (!doc) return;
      setActiveDocId(id);
      setEditingName(false);
      const pos = getInitialCursorForDoc(doc.content);
      setSelectionRange({ start: pos, end: pos });
      requestAnimationFrame(() => {
        editorRef.current?.jumpToOffset(pos, false);
      });
    },
    [documents]
  );

  const handleCreateDoc = useCallback(() => {
    const newId = `doc-${Date.now()}`;
    const idx = documents.length + 1;
    const newDoc: DataDocument = {
      id: newId,
      name: `dataset_${idx}.json`,
      format: 'json',
      updatedAt: Date.now(),
      content: `{\n  "name": "新建数据文档",\n  "records": [\n    {\n      "id": 1,\n      "tags": ["draft"]\n    }\n  ]\n}`,
    };
    setDocuments((prev) => [newDoc, ...prev]);
    setActiveDocId(newId);
    const pos = newDoc.content.indexOf('[');
    setSelectionRange({ start: pos, end: pos });
    requestAnimationFrame(() => {
      editorRef.current?.jumpToOffset(pos, false);
    });
    notify(`已创建 ${newDoc.name}`);
  }, [documents.length, notify]);

  const handleImportDoc = useCallback(
    (name: string, content: string, format: DataFormat) => {
      const newId = `doc-${Date.now()}`;
      const newDoc: DataDocument = {
        id: newId,
        name,
        format,
        content,
        updatedAt: Date.now(),
      };
      setDocuments((prev) => [newDoc, ...prev]);
      setActiveDocId(newId);
      const pos = getInitialCursorForDoc(content);
      setSelectionRange({ start: pos, end: pos });
      requestAnimationFrame(() => {
        editorRef.current?.jumpToOffset(pos, false);
      });
      notify(`已导入 ${name}`);
    },
    [notify]
  );

  const handleOpenExtractedDoc = useCallback(
    (name: string, content: string) => {
      handleImportDoc(name, content, 'json');
    },
    [handleImportDoc]
  );

  const handleOpenExtractPanel = useCallback(() => {
    setShowInspector(true);
    setInspectorTab('extract');
  }, []);

  const handleLocateInStructureTree = useCallback(() => {
    if (activeDoc.format === 'expression') {
      notify('多括号表达式模式暂无结构树，请切换至 JSON / JSONC 格式');
      return;
    }
    if (!validation.valid || structureTree.length === 0) {
      notify('当前文档存在语法错误，修复后即可定位结构树节点');
      return;
    }
    setShowInspector(true);
    setInspectorTab('structure');
    const loc = findStructureNodeAtOffset(
      structureTree,
      selectionRange.start,
      cursorLineCol.line
    );
    setLocateRequest({
      seq: ++locateSeqRef.current,
      offset: selectionRange.start,
      line: cursorLineCol.line,
    });
    if (loc) {
      notify(`已定位节点：${loc.path}（第 ${loc.node.line} 行）`);
    }
  }, [
    activeDoc.format,
    validation.valid,
    structureTree,
    selectionRange.start,
    cursorLineCol.line,
    notify,
  ]);

  const isStringInnerSelected = Boolean(
    activeString &&
      activeString.contentEnd > activeString.contentStart &&
      selectionRange.start === activeString.contentStart &&
      selectionRange.end === activeString.contentEnd
  );

  const handleSelectStringContent = useCallback(() => {
    if (!activeString) {
      notify('当前光标不在字符串内部');
      return;
    }

    const contentLen = activeString.contentEnd - activeString.contentStart;
    if (contentLen === 0) {
      editorRef.current?.selectRange(activeString.token.start, activeString.token.end);
      notify('该字符串为空，已选中引号范围');
      return;
    }

    if (isStringInnerSelected && activeString.isClosed) {
      editorRef.current?.selectRange(activeString.token.start, activeString.token.end);
      notify('已扩展选中含引号字符串');
      return;
    }

    editorRef.current?.selectRange(activeString.contentStart, activeString.contentEnd);
    notify(`已选中${activeString.isKey ? '键名' : '字符串'}内容（${contentLen} 字符）`);
  }, [activeString, isStringInnerSelected, notify]);

  const handleDeleteDoc = useCallback(
    (id: string) => {
      setDocuments((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((d) => d.id !== id);
        if (id === activeDocId) {
          setActiveDocId(next[0].id);
          const pos = getInitialCursorForDoc(next[0].content);
          setSelectionRange({ start: pos, end: pos });
        }
        return next;
      });
      notify('已移除文档');
    },
    [activeDocId, notify]
  );

  const handleFormatChange = useCallback(
    (format: DataFormat) => {
      setDocuments((prev) =>
        prev.map((d) => (d.id === activeDoc.id ? { ...d, format } : d))
      );
    },
    [activeDoc.id]
  );

  const handleRenameCommit = useCallback(() => {
    const trimmed = nameDraft.trim();
    if (trimmed) {
      setDocuments((prev) =>
        prev.map((d) => (d.id === activeDoc.id ? { ...d, name: trimmed } : d))
      );
    }
    setEditingName(false);
  }, [activeDoc.id, nameDraft]);

  // Data transformation handlers
  const handleBeautify = useCallback(() => {
    const res = formatJsonText(activeDoc.content, activeDoc.format, 2);
    if (!res.ok) {
      notify(res.error ?? '格式化失败');
      return;
    }
    clearActiveFolds();
    updateActiveContent(res.result, true, { label: '格式化 JSON', forceSnapshot: true });
    notify('已按 2 空格缩进格式化');
  }, [activeDoc.content, activeDoc.format, clearActiveFolds, updateActiveContent, notify]);

  const handleMinify = useCallback(() => {
    const res = minifyJsonText(activeDoc.content, activeDoc.format);
    if (!res.ok) {
      notify(res.error ?? '压缩失败');
      return;
    }
    clearActiveFolds();
    updateActiveContent(res.result, true, { label: '压缩数据', forceSnapshot: true });
    notify('已压缩为单行数据');
  }, [activeDoc.content, activeDoc.format, clearActiveFolds, updateActiveContent, notify]);

  const handleSortKeys = useCallback(() => {
    const res = sortJsonKeysText(activeDoc.content, activeDoc.format);
    if (!res.ok) {
      notify(res.error ?? '排序失败');
      return;
    }
    clearActiveFolds();
    updateActiveContent(res.result, true, { label: '键名排序', forceSnapshot: true });
    notify('已按字母顺序递归排序所有键名');
  }, [activeDoc.content, activeDoc.format, clearActiveFolds, updateActiveContent, notify]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(activeDoc.content);
      setCopied(true);
      notify('已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      notify('复制失败，请手动选中复制');
    }
  }, [activeDoc.content, notify]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([activeDoc.content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeDoc.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notify(`已导出 ${activeDoc.name}`);
  }, [activeDoc.content, activeDoc.name, notify]);

  // Compute contextual bracket jump button label & state
  const bracketAction = useMemo(() => {
    if (activeBracket) {
      if (activeBracket.isMatched && activeBracket.partner) {
        return {
          available: true,
          prominent: true,
          isOpen: activeBracket.token.isOpen,
          label: activeBracket.token.isOpen
            ? `跳至右括号 ${activeBracket.partner.char}`
            : `跳至左括号 ${activeBracket.partner.char}`,
          meta: `行 ${activeBracket.partner.line}`,
          unmatched: false,
        };
      }
      return {
        available: false,
        prominent: false,
        isOpen: activeBracket.token.isOpen,
        label: `未闭合 ${activeBracket.token.char}`,
        meta: `行 ${activeBracket.token.line}`,
        unmatched: true,
      };
    }

    if (enclosingPair) {
      return {
        available: true,
        prominent: false,
        isOpen: true,
        label: `跳至块尾 ${enclosingPair.closeChar}`,
        meta: `行 ${enclosingPair.closeLine}`,
        unmatched: false,
      };
    }

    return {
      available: false,
      prominent: false,
      isOpen: true,
      label: '跳转匹配括号',
      meta: 'Ctrl+M',
      unmatched: false,
    };
  }, [activeBracket, enclosingPair]);

  const selectionLen = Math.abs(selectionRange.end - selectionRange.start);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Top Workspace Header: 3-zone clean SaaS structure */}
      <header className="h-13 shrink-0 px-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex items-center justify-between gap-4">
        {/* Left: Brand Wordmark + Active File Breadcrumb */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setShowSidebar((v) => !v)}
            aria-label={showSidebar ? '收起文件侧边栏' : '展开文件侧边栏'}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
          >
            <PanelLeft className="w-4 h-4" />
          </button>

          <span className="text-[15px] font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            数构编辑器
          </span>

          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700 shrink-0">
            /
          </span>

          {editingName ? (
            <input
              type="text"
              value={nameDraft}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={handleRenameCommit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameCommit();
                if (e.key === 'Escape') setEditingName(false);
              }}
              className="w-44 text-sm font-code px-1.5 py-0.5 rounded border border-blue-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setNameDraft(activeDoc.name);
                setEditingName(true);
              }}
              title="点击重命名文件"
              className="text-sm font-code text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white truncate max-w-[200px] sm:max-w-[280px] transition-colors cursor-pointer"
            >
              {activeDoc.name}
            </button>
          )}
        </div>

        {/* Center: Clean Format Mode Segmented Selector */}
        <div className="hidden md:flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 shrink-0">
          {(
            [
              { id: 'json', label: 'JSON' },
              { id: 'jsonc', label: 'JSONC (含注释)' },
              { id: 'expression', label: '多括号表达式' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handleFormatChange(item.id)}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
                activeDoc.format === item.id
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Right: Utility Toggles & Primary Export CTA */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            aria-label={darkMode ? '切换浅色主题' : '切换深色主题'}
            title={darkMode ? '切换浅色主题' : '切换深色主题'}
            className="p-2 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={() => setShowInspector((v) => !v)}
            aria-label={showInspector ? '隐藏括号与结构面板' : '显示括号与结构面板'}
            title={showInspector ? '隐藏括号与结构面板' : '显示括号与结构面板'}
            className={`p-2 rounded-md transition-colors cursor-pointer ${
              showInspector
                ? 'text-blue-600 dark:text-sky-400 bg-blue-50 dark:bg-blue-500/15'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <PanelRight className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>导出文件</span>
          </button>
        </div>
      </header>

      {/* Workspace Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* Left Sidebar */}
        {showSidebar && (
          <div className="absolute inset-y-0 left-0 z-30 flex lg:static lg:z-auto shadow-xl lg:shadow-none bg-white dark:bg-slate-950 min-h-0">
            <Sidebar
              documents={documents}
              activeId={activeDoc.id}
              onSelect={handleSelectDoc}
              onCreate={handleCreateDoc}
              onImport={handleImportDoc}
              onDelete={handleDeleteDoc}
            />
          </div>
        )}

        {/* Center Main Editor Column */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Editor Action Toolbar */}
          <div className="shrink-0 min-h-11 px-3.5 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 flex flex-wrap items-center justify-between gap-2">
            {/* Left Group: Data Transform & Edit Actions */}
            <div className="flex items-center gap-1 flex-wrap">
              <button
                type="button"
                onClick={handleBeautify}
                disabled={activeDoc.format === 'expression'}
                title="格式化 JSON (2空格缩进)"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap transition-colors cursor-pointer"
              >
                <AlignLeft className="w-3.5 h-3.5" />
                <span>格式化</span>
              </button>

              <button
                type="button"
                onClick={handleMinify}
                disabled={activeDoc.format === 'expression'}
                title="压缩为单行"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap transition-colors cursor-pointer"
              >
                <Minimize2 className="w-3.5 h-3.5" />
                <span>压缩</span>
              </button>

              <button
                type="button"
                onClick={handleSortKeys}
                disabled={activeDoc.format === 'expression'}
                title="按字母顺序排序键名"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap transition-colors cursor-pointer"
              >
                <ArrowDownAZ className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">键名排序</span>
              </button>

              <span
                aria-hidden="true"
                className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1"
              />

              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleUndo}
                disabled={currentHistory.past.length === 0}
                title={`撤销上一步 (Ctrl+Z)${currentHistory.past.length > 0 ? ` · 可撤销 ${currentHistory.past.length} 步` : ''}`}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed whitespace-nowrap transition-colors cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline">撤销</span>
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleRedo}
                disabled={currentHistory.future.length === 0}
                title={`重做下一步 (Ctrl+Y / Ctrl+Shift+Z)${currentHistory.future.length > 0 ? ` · 可重做 ${currentHistory.future.length} 步` : ''}`}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed whitespace-nowrap transition-colors cursor-pointer"
              >
                <Redo2 className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline">重做</span>
              </button>
              <HistoryMenu
                past={currentHistory.past}
                future={currentHistory.future}
                currentLineCount={analysis.lineStarts.length}
                currentCharCount={activeDoc.content.length}
                onRollbackToPastIndex={handleRollbackToPastIndex}
                onAdvanceToFutureIndex={handleAdvanceToFutureIndex}
              />

              <button
                type="button"
                onClick={() => editorRef.current?.openSearch(false)}
                title="查找与替换 (Ctrl+F)"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 whitespace-nowrap transition-colors cursor-pointer"
              >
                <Search className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">查找</span>
              </button>

              <button
                type="button"
                onClick={handleCopy}
                title="复制全部内容"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 whitespace-nowrap transition-colors cursor-pointer"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">{copied ? '已复制' : '复制'}</span>
              </button>

              <span
                aria-hidden="true"
                className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1"
              />

              <button
                type="button"
                onClick={handleFoldAll}
                title="收缩顶层结构块"
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 whitespace-nowrap transition-colors cursor-pointer"
              >
                <ChevronsDownUp className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">收缩块</span>
              </button>

              <button
                type="button"
                onClick={handleUnfoldAll}
                disabled={collapsedLines.size === 0}
                title="展开全部已收缩结构块"
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-35 whitespace-nowrap transition-colors cursor-pointer"
              >
                <ChevronsUpDown className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">全部展开</span>
              </button>

              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleLocateInStructureTree}
                disabled={activeDoc.format === 'expression'}
                title="定位当前光标所在位置的结构树节点"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                <LocateFixed className="w-3.5 h-3.5" />
                <span>定位节点</span>
              </button>

              <button
                type="button"
                onClick={handleOpenExtractPanel}
                title="按条件或表达式提取数组对象与指定字段"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  showInspector && inspectorTab === 'extract'
                    ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-sky-300'
                    : 'text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800'
                }`}
              >
                <Filter className="w-3.5 h-3.5" />
                <span>数据提取</span>
              </button>
            </div>

            {/* Right Group: Primary Signature Bracket Jump Controls */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowFloatingHint((v) => !v)}
                title="光标位于括号处时，在编辑区显示快捷跳转浮窗"
                className={`hidden xl:inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors cursor-pointer ${
                  showFloatingHint
                    ? 'text-slate-700 dark:text-slate-200 bg-slate-200/70 dark:bg-slate-800'
                    : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                <MousePointerClick className="w-3.5 h-3.5" />
                <span>行内浮窗</span>
              </button>

              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleSelectStringContent}
                disabled={!activeString}
                title={
                  activeString
                    ? isStringInnerSelected
                      ? '再次点击扩展选中引号范围'
                      : `一键选中当前${activeString.isKey ? '键名' : '字符串'}内部内容`
                    : '将光标移入字符串内部后，可一键选中其内容'
                }
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium whitespace-nowrap transition-colors cursor-pointer disabled:cursor-not-allowed ${
                  activeString
                    ? 'border-emerald-300 dark:border-emerald-700/70 bg-emerald-50/80 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/25'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 disabled:opacity-40'
                }`}
              >
                <TextSelect className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline">
                  {isStringInnerSelected ? '含引号选中' : '选中字符串'}
                </span>
              </button>

              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  editorRef.current?.selectBracketBlock();
                }}
                disabled={!activeBracket?.pair && !enclosingPair}
                title="选中当前括号内完整块 (Ctrl+Shift+M)"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap transition-colors cursor-pointer"
              >
                <Brackets className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">选中括号块</span>
              </button>

              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  editorRef.current?.jumpToMatchingBracket();
                }}
                disabled={!bracketAction.available}
                title="光标处于左括号时跳转至匹配右括号，或双向跳转 (Ctrl+M / Ctrl+Shift+\)"
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  bracketAction.unmatched
                    ? 'bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
                    : bracketAction.prominent
                    ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-xs'
                    : bracketAction.available
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-blue-600 dark:hover:bg-blue-500 dark:hover:text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                }`}
              >
                {bracketAction.isOpen ? (
                  <CornerDownRight className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <CornerUpLeft className="w-3.5 h-3.5 shrink-0" />
                )}
                <span className="font-code">{bracketAction.label}</span>
                <span className="font-code text-[11px] tabular-nums opacity-80">
                  {bracketAction.meta}
                </span>
              </button>
            </div>
          </div>

          {/* Code Editor Surface */}
          <CodeEditor
            ref={editorRef}
            value={activeDoc.content}
            onChange={handleEditorChange}
            onUndo={handleUndo}
            onRedo={handleRedo}
            analysis={analysis}
            activeBracket={activeBracket}
            enclosingPair={enclosingPair}
            validation={validation}
            cursorOffset={selectionRange.start}
            selectionRange={selectionRange}
            onCursorChange={handleCursorChange}
            collapsedLines={collapsedLines}
            onToggleFold={handleToggleFold}
            onCollapsedLinesChange={handleCollapsedLinesChange}
            showFloatingHint={showFloatingHint}
            autoCloseBrackets={true}
            onNotify={notify}
          />

          {/* Clean Editor Footer: Strictly Real Validation, Match Info & Caret Coordinates */}
          <footer className="h-8 shrink-0 px-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 flex items-center justify-between gap-4 text-xs text-slate-600 dark:text-slate-400 select-none">
            <div className="flex items-center gap-3 min-w-0">
              {validation.valid ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>{validation.message}</span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (validation.errorOffset !== undefined) {
                      editorRef.current?.jumpToOffset(validation.errorOffset, true);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 text-red-600 dark:text-red-400 hover:underline truncate cursor-pointer"
                  title="点击定位至错误位置"
                >
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{validation.message}</span>
                </button>
              )}

              {activeBracket && (
                <>
                  <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                    ·
                  </span>
                  {activeBracket.isMatched && activeBracket.partner ? (
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        editorRef.current?.jumpToMatchingBracket();
                      }}
                      className="hidden sm:inline-flex items-center gap-1 text-blue-600 dark:text-sky-400 hover:underline whitespace-nowrap cursor-pointer font-code tabular-nums"
                    >
                      <span>
                        匹配 {activeBracket.pair?.openChar}
                        {activeBracket.pair?.closeChar}
                      </span>
                      <span>
                        (L{activeBracket.pair?.openLine}→L{activeBracket.pair?.closeLine})
                      </span>
                    </button>
                  ) : (
                    <span className="hidden sm:inline text-red-600 dark:text-red-400 whitespace-nowrap">
                      括号 "{activeBracket.token.char}" 缺少匹配项
                    </span>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-2.5 font-code text-[11px] tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
              {collapsedLines.size > 0 && (
                <>
                  <button
                    type="button"
                    onClick={handleUnfoldAll}
                    className="text-blue-600 dark:text-sky-400 hover:underline cursor-pointer"
                    title="点击展开全部已收缩结构块"
                  >
                    已收缩 {collapsedLines.size} 块
                  </button>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <span>
                行 {cursorLineCol.line}, 列 {cursorLineCol.col}
              </span>
              {selectionLen > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>已选 {selectionLen} 字符</span>
                </>
              )}
              <span aria-hidden="true" className="hidden sm:inline">
                ·
              </span>
              <span className="hidden sm:inline">共 {analysis.lineStarts.length} 行</span>
              <span aria-hidden="true" className="hidden md:inline">
                ·
              </span>
              <span className="hidden md:inline">{formattedByteSize}</span>
            </div>
          </footer>
        </main>

        {/* Right Inspector Panel */}
        {showInspector && (
          <div className="absolute inset-y-0 right-0 z-30 flex md:static md:z-auto shadow-xl md:shadow-none bg-white dark:bg-slate-950 min-h-0">
            <InspectorPanel
              activeTab={inspectorTab}
              onTabChange={setInspectorTab}
              analysis={deferredAnalysis}
              structureTree={structureTree}
              parsedData={validation.parsedValue}
              isValidJson={validation.valid && activeDoc.format !== 'expression'}
              docName={activeDoc.name}
              activePairId={activeBracket?.pair?.id ?? enclosingPair?.id ?? null}
              cursorOffset={selectionRange.start}
              cursorLine={cursorLineCol.line}
              locateRequest={locateRequest}
              onLocateCursorNode={handleLocateInStructureTree}
              onJumpToOffset={handleInspectorJump}
              onSelectRange={handleInspectorSelect}
              onOpenExtractedDoc={handleOpenExtractedDoc}
              onNotify={notify}
            />
          </div>
        )}
      </div>

      {/* Transient Action Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-11 left-1/2 -translate-x-1/2 z-50 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium shadow-lg pointer-events-none"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
