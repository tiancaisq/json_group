import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownRight,
  CornerUpLeft,
  Filter,
  ListTree,
  LocateFixed,
  Search,
} from 'lucide-react';
import {
  BracketAnalysis,
  StructureNode,
} from '../types/editor';
import { findStructureNodeAtOffset } from '../utils/dataParser';
import { DataExtractPanel } from './DataExtractPanel';

export type InspectorTab = 'brackets' | 'structure' | 'extract';

export interface LocateTreeRequest {
  seq: number;
  offset: number;
  line: number;
}

interface InspectorPanelProps {
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  analysis: BracketAnalysis;
  structureTree: StructureNode[];
  parsedData: unknown;
  isValidJson: boolean;
  docName: string;
  activePairId: string | null;
  cursorOffset: number;
  cursorLine: number;
  locateRequest: LocateTreeRequest | null;
  onLocateCursorNode: () => void;
  onJumpToOffset: (offset: number) => void;
  onSelectRange: (start: number, end: number) => void;
  onOpenExtractedDoc: (name: string, content: string) => void;
  onNotify?: (message: string) => void;
}

const PAGE_SIZE = 100;

const TYPE_COLOR: Record<StructureNode['type'], string> = {
  object: 'text-blue-600 dark:text-sky-400',
  array: 'text-teal-600 dark:text-teal-400',
  string: 'text-emerald-700 dark:text-emerald-400',
  number: 'text-amber-700 dark:text-amber-400',
  boolean: 'text-violet-700 dark:text-violet-400',
  null: 'text-rose-600 dark:text-rose-400',
};

function collectDeepIds(nodes: StructureNode[], maxOpenDepth: number, out: Set<string>) {
  for (const n of nodes) {
    if (n.children && n.children.length > 0) {
      if (n.depth >= maxOpenDepth) {
        out.add(n.id);
      }
      collectDeepIds(n.children, maxOpenDepth, out);
    }
  }
}

interface TreeNodeRowProps {
  node: StructureNode;
  collapsedIds: Set<string>;
  toggleCollapse: (id: string) => void;
  onJumpToOffset: (offset: number) => void;
  activeNodeId: string | null;
  flashNodeId: string | null;
}

const TreeNodeRow = memo(function TreeNodeRow({
  node,
  collapsedIds,
  toggleCollapse,
  onJumpToOffset,
  activeNodeId,
  flashNodeId,
}: TreeNodeRowProps) {
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const isCollapsed = collapsedIds.has(node.id);
  const isActive = activeNodeId === node.id;
  const isFlashed = flashNodeId === node.id;

  return (
    <div>
      <div
        data-node-id={node.id}
        onClick={() => onJumpToOffset(node.offset)}
        style={{ paddingLeft: `${8 + node.depth * 14}px` }}
        className={`group flex items-center gap-1.5 pr-3 py-1.5 text-xs cursor-pointer border-l-2 transition-colors ${
          isFlashed
            ? 'border-blue-600 dark:border-sky-400 bg-blue-100 dark:bg-sky-500/25 text-blue-950 dark:text-sky-50 ring-1 ring-inset ring-blue-400/70 dark:ring-sky-400/60'
            : isActive
            ? 'border-blue-600 dark:border-sky-400 bg-blue-50/90 dark:bg-blue-500/15 text-blue-900 dark:text-sky-100'
            : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/70 text-slate-700 dark:text-slate-300'
        }`}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(node.id);
            }}
            aria-label={isCollapsed ? '展开节点' : '折叠节点'}
            className="p-0.5 -ml-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
          >
            {isCollapsed ? (
              <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <span className="font-code font-medium truncate text-slate-800 dark:text-slate-200">
          {node.key}
        </span>

        <span className={`font-code truncate text-[11px] ml-1 ${TYPE_COLOR[node.type]}`}>
          {node.preview}
        </span>

        <span className="ml-auto font-code text-[11px] tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
          L{node.line}
        </span>
      </div>

      {hasChildren && !isCollapsed && (
        <div>
          {node.children!.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              collapsedIds={collapsedIds}
              toggleCollapse={toggleCollapse}
              onJumpToOffset={onJumpToOffset}
              activeNodeId={activeNodeId}
              flashNodeId={flashNodeId}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export const InspectorPanel = memo(function InspectorPanel({
  activeTab,
  onTabChange,
  analysis,
  structureTree,
  parsedData,
  isValidJson,
  docName,
  activePairId,
  cursorOffset,
  cursorLine,
  locateRequest,
  onLocateCursorNode,
  onJumpToOffset,
  onSelectRange,
  onOpenExtractedDoc,
  onNotify,
}: InspectorPanelProps) {
  const [filterText, setFilterText] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [flashNodeId, setFlashNodeId] = useState<string | null>(null);
  const [pendingScroll, setPendingScroll] = useState<{ id: string; seq: number } | null>(null);

  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const lastHandledLocateSeqRef = useRef<number>(0);
  const flashTimerRef = useRef<number | null>(null);

  // Auto-collapse deeper tree branches when document has many pairs to keep DOM lean
  useEffect(() => {
    if (analysis.pairs.length > 60 && structureTree.length > 0) {
      const next = new Set<string>();
      collectDeepIds(structureTree, 2, next);
      setCollapsedIds(next);
    } else {
      setCollapsedIds(new Set());
    }
  }, [structureTree, analysis.pairs.length]);

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [filterText, analysis.pairs.length]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  const currentCursorMatch = useMemo(() => {
    if (activeTab !== 'structure' || structureTree.length === 0) return null;
    return findStructureNodeAtOffset(structureTree, cursorOffset, cursorLine);
  }, [activeTab, structureTree, cursorOffset, cursorLine]);

  // Handle explicit "locate current cursor node" requests
  useEffect(() => {
    if (
      !locateRequest ||
      locateRequest.seq === lastHandledLocateSeqRef.current ||
      structureTree.length === 0
    ) {
      return;
    }
    lastHandledLocateSeqRef.current = locateRequest.seq;

    const match = findStructureNodeAtOffset(
      structureTree,
      locateRequest.offset,
      locateRequest.line
    );
    if (!match) return;

    if (match.ancestorIds.length > 0) {
      setCollapsedIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const id of match.ancestorIds) {
          if (next.delete(id)) changed = true;
        }
        return changed ? next : prev;
      });
    }

    setFlashNodeId(match.node.id);
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      setFlashNodeId(null);
      flashTimerRef.current = null;
    }, 1500);

    setPendingScroll({ id: match.node.id, seq: locateRequest.seq });
  }, [locateRequest, structureTree]);

  // Scroll the located node into the center of the tree viewport once ancestors have expanded
  useEffect(() => {
    if (!pendingScroll || activeTab !== 'structure') return;
    const container = bodyScrollRef.current;
    if (!container) return;
    const target = container.querySelector(
      `[data-node-id="${pendingScroll.id}"]`
    ) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setPendingScroll(null);
    }
  }, [pendingScroll, activeTab, collapsedIds]);

  const filteredPairs = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return analysis.pairs;
    return analysis.pairs.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        `${p.openChar}${p.closeChar}`.includes(q) ||
        String(p.openLine).includes(q) ||
        String(p.closeLine).includes(q)
    );
  }, [analysis.pairs, filterText]);

  const visiblePairs = useMemo(
    () =>
      filteredPairs.length > visibleLimit
        ? filteredPairs.slice(0, visibleLimit)
        : filteredPairs,
    [filteredPairs, visibleLimit]
  );

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExpandAllNodes = useCallback(() => {
    setCollapsedIds(new Set());
  }, []);

  const handleCollapseChildNodes = useCallback(() => {
    if (structureTree.length === 0) return;
    const next = new Set<string>();
    collectDeepIds(structureTree, 1, next);
    setCollapsedIds(next);
  }, [structureTree]);

  return (
    <aside
      className={`${
        activeTab === 'extract' ? 'w-96 xl:w-[420px]' : 'w-76 xl:w-80'
      } shrink-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex flex-col min-h-0`}
    >
      {/* Segmented Switcher */}
      <div className="shrink-0 p-3 border-b border-slate-200 dark:border-slate-800">
        <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
          <button
            type="button"
            onClick={() => onTabChange('brackets')}
            className={`flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
              activeTab === 'brackets'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Braces className="w-3.5 h-3.5 shrink-0" />
            <span>括号</span>
            <span className="font-code text-[11px] tabular-nums opacity-70">
              {analysis.pairs.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => onTabChange('structure')}
            className={`flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
              activeTab === 'structure'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <ListTree className="w-3.5 h-3.5 shrink-0" />
            <span>结构树</span>
          </button>
          <button
            type="button"
            onClick={() => onTabChange('extract')}
            className={`flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
              activeTab === 'extract'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Filter className="w-3.5 h-3.5 shrink-0" />
            <span>数据提取</span>
          </button>
        </div>

        {/* Filter input for Bracket Pairs */}
        {activeTab === 'brackets' && (
          <div className="mt-2.5 flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 focus-within:border-blue-500">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="按字段名或行号筛选括号..."
              className="w-full text-xs bg-transparent outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
            />
          </div>
        )}

        {/* Structure Tree Locator & Tree Controls */}
        {activeTab === 'structure' && (
          <div className="mt-2.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onLocateCursorNode}
                disabled={structureTree.length === 0}
                title="自动展开并滚动至当前光标所在的结构树节点"
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 text-white disabled:text-slate-400 dark:disabled:text-slate-500 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                <LocateFixed className="w-3.5 h-3.5 shrink-0" />
                <span>定位当前光标节点</span>
              </button>

              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleExpandAllNodes}
                disabled={structureTree.length === 0 || collapsedIds.size === 0}
                title="展开全部结构树节点"
                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronsUpDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCollapseChildNodes}
                disabled={structureTree.length === 0}
                title="折叠结构树子节点"
                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronsDownUp className="w-3.5 h-3.5" />
              </button>
            </div>

            {currentCursorMatch && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onLocateCursorNode}
                title={`点击定位：${currentCursorMatch.path}`}
                className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded bg-white dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 hover:border-blue-400 dark:hover:border-sky-500/60 text-[11px] text-left transition-colors cursor-pointer"
              >
                <span className="font-code text-slate-600 dark:text-slate-300 truncate">
                  {currentCursorMatch.path}
                </span>
                <span className="font-code tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
                  L{currentCursorMatch.node.line}
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Unmatched Bracket Alert List */}
      {activeTab !== 'extract' && analysis.unmatched.length > 0 && (
        <div className="shrink-0 px-3 py-2.5 border-b border-red-200 dark:border-red-900/50 bg-red-50/70 dark:bg-red-950/30">
          <div className="text-xs font-medium text-red-700 dark:text-red-300 mb-1.5">
            未闭合括号（{analysis.unmatched.length} 处）
          </div>
          <div className="space-y-1">
            {analysis.unmatched.slice(0, 4).map((b) => (
              <button
                key={b.index}
                type="button"
                onClick={() => onJumpToOffset(b.index)}
                className="w-full flex items-center justify-between text-xs px-2 py-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-red-700 dark:text-red-300 cursor-pointer"
              >
                <span className="font-code font-semibold">{b.char}</span>
                <span className="font-code tabular-nums text-[11px]">
                  第 {b.line} 行, 列 {b.col}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Panel Body */}
      {activeTab === 'extract' ? (
        <DataExtractPanel
          parsedData={parsedData}
          isValidJson={isValidJson}
          docName={docName}
          onOpenAsNewDoc={onOpenExtractedDoc}
          onNotify={onNotify}
        />
      ) : (
      <div ref={bodyScrollRef} className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'brackets' ? (
          visiblePairs.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
              {analysis.pairs.length === 0
                ? '文档中暂无可匹配的括号对'
                : '没有符合筛选条件的括号对'}
            </div>
          ) : (
            <div className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
              {visiblePairs.map((pair) => {
                const isActive = pair.id === activePairId;
                const lineSpan = pair.closeLine - pair.openLine + 1;

                return (
                  <div
                    key={pair.id}
                    className={`px-3 py-2 ${
                      isActive
                        ? 'bg-blue-50/90 dark:bg-blue-500/12'
                        : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onJumpToOffset(pair.openIndex)}
                        style={{ paddingLeft: `${Math.min(pair.depth, 5) * 8}px` }}
                        className="flex items-center gap-1.5 min-w-0 text-left cursor-pointer"
                      >
                        <span
                          className={`font-code text-xs font-semibold shrink-0 ${
                            pair.openChar === '{'
                              ? 'text-blue-600 dark:text-sky-400'
                              : pair.openChar === '['
                              ? 'text-teal-600 dark:text-teal-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {pair.openChar}
                          {pair.closeChar}
                        </span>
                        <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                          {pair.label}
                        </span>
                      </button>

                      <span className="font-code text-[11px] tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
                        L{pair.openLine}→{pair.closeLine}
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="tabular-nums">
                        层级 {pair.depth + 1} · {lineSpan} 行
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onJumpToOffset(pair.openIndex)}
                          className="inline-flex items-center gap-0.5 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-sky-400 cursor-pointer whitespace-nowrap"
                          title={`跳至左括号 ${pair.openChar} (第 ${pair.openLine} 行)`}
                        >
                          <CornerUpLeft className="w-3 h-3" />
                          <span>左 {pair.openChar}</span>
                        </button>
                        <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                          ·
                        </span>
                        <button
                          type="button"
                          onClick={() => onJumpToOffset(pair.closeIndex)}
                          className="inline-flex items-center gap-0.5 text-blue-600 dark:text-sky-400 hover:underline cursor-pointer whitespace-nowrap font-medium"
                          title={`跳至右括号 ${pair.closeChar} (第 ${pair.closeLine} 行)`}
                        >
                          <CornerDownRight className="w-3 h-3" />
                          <span>右 {pair.closeChar}</span>
                        </button>
                        <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                          ·
                        </span>
                        <button
                          type="button"
                          onClick={() => onSelectRange(pair.openIndex, pair.closeIndex + 1)}
                          className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer whitespace-nowrap"
                        >
                          选中
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {filteredPairs.length > visibleLimit && (
                <div className="p-3 text-center">
                  <button
                    type="button"
                    onClick={() => setVisibleLimit((n) => n + PAGE_SIZE)}
                    className="px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    加载更多（剩余 {filteredPairs.length - visibleLimit} 组）
                  </button>
                </div>
              )}
            </div>
          )
        ) : structureTree.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            仅在有效的 JSON / JSONC 文档下展示结构树。当前可在左侧切换格式或使用「括号索引」导航。
          </div>
        ) : (
          <div className="py-2">
            {structureTree.map((root) => (
              <TreeNodeRow
                key={root.id}
                node={root}
                collapsedIds={collapsedIds}
                toggleCollapse={toggleCollapse}
                onJumpToOffset={onJumpToOffset}
                activeNodeId={currentCursorMatch?.node.id ?? null}
                flashNodeId={flashNodeId}
              />
            ))}
          </div>
        )}
      </div>
      )}
    </aside>
  );
});
