import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Copy,
  Download,
  FilePlus2,
  Filter,
  HelpCircle,
  ListTree,
  Plus,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import {
  buildSuggestedExpressions,
  ConditionType,
  discoverArrays,
  runExtractExpression,
  VisualCondition,
  VisualExtractConfig,
  visualConfigToExpression,
} from '../utils/dataExtractor';

interface DataExtractPanelProps {
  parsedData: unknown;
  isValidJson: boolean;
  docName: string;
  onOpenAsNewDoc: (name: string, content: string) => void;
  onNotify?: (message: string) => void;
}

type ExtractMode = 'visual' | 'expression';
type ResultViewTab = 'json' | 'tree';

interface ResultTreeNode {
  id: string;
  key: string;
  path: string;
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined';
  preview: string;
  rawValue: unknown;
  depth: number;
  children?: ResultTreeNode[];
}

const RESULT_TYPE_COLOR: Record<ResultTreeNode['type'], string> = {
  object: 'text-blue-600 dark:text-sky-400',
  array: 'text-teal-600 dark:text-teal-400',
  string: 'text-emerald-700 dark:text-emerald-400',
  number: 'text-amber-700 dark:text-amber-400',
  boolean: 'text-violet-700 dark:text-violet-400',
  null: 'text-rose-600 dark:text-rose-400',
  undefined: 'text-slate-400 dark:text-slate-500',
};

function buildResultTree(data: unknown): { nodes: ResultTreeNode[]; totalNodes: number } {
  let seq = 0;

  const formatChildPath = (parentPath: string, key: string): string => {
    if (/^\[\d+\]$/.test(key)) return `${parentPath}${key}`;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parentPath}.${key}`;
    return `${parentPath}[${JSON.stringify(key)}]`;
  };

  const buildNode = (
    value: unknown,
    key: string,
    path: string,
    depth: number
  ): ResultTreeNode => {
    const id = `res-node-${++seq}`;

    if (value === null) {
      return { id, key, path, type: 'null', preview: 'null', rawValue: value, depth };
    }
    if (value === undefined) {
      return { id, key, path, type: 'undefined', preview: 'undefined', rawValue: value, depth };
    }
    if (Array.isArray(value)) {
      const children = value.map((item, idx) =>
        buildNode(item, `[${idx}]`, formatChildPath(path, `[${idx}]`), depth + 1)
      );
      return {
        id,
        key,
        path,
        type: 'array',
        preview: `[ ${children.length} 项 ]`,
        rawValue: value,
        depth,
        children,
      };
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      const children = entries.map(([k, v]) =>
        buildNode(v, k, formatChildPath(path, k), depth + 1)
      );
      return {
        id,
        key,
        path,
        type: 'object',
        preview: `{ ${children.length} 项 }`,
        rawValue: value,
        depth,
        children,
      };
    }
    if (typeof value === 'string') {
      const truncated = value.length > 36 ? `${value.slice(0, 36)}…` : value;
      return {
        id,
        key,
        path,
        type: 'string',
        preview: `"${truncated}"`,
        rawValue: value,
        depth,
      };
    }
    if (typeof value === 'number') {
      return { id, key, path, type: 'number', preview: String(value), rawValue: value, depth };
    }
    if (typeof value === 'boolean') {
      return { id, key, path, type: 'boolean', preview: String(value), rawValue: value, depth };
    }
    return { id, key, path, type: 'string', preview: String(value), rawValue: value, depth };
  };

  const root = buildNode(data, 'result', 'result', 0);
  return { nodes: [root], totalNodes: seq };
}

function collectResultTreeDeepIds(
  nodes: ResultTreeNode[],
  minDepth: number,
  out: Set<string>
) {
  for (const n of nodes) {
    if (n.children && n.children.length > 0) {
      if (n.depth >= minDepth) {
        out.add(n.id);
      }
      collectResultTreeDeepIds(n.children, minDepth, out);
    }
  }
}

interface ResultTreeRowProps {
  node: ResultTreeNode;
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
  onCopyNodeValue: (node: ResultTreeNode) => void;
}

const ResultTreeRow = memo(function ResultTreeRow({
  node,
  collapsedIds,
  onToggleCollapse,
  onCopyNodeValue,
}: ResultTreeRowProps) {
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const isCollapsed = collapsedIds.has(node.id);

  return (
    <div>
      <div
        onClick={() => {
          if (hasChildren) onToggleCollapse(node.id);
        }}
        title={`${node.path}: ${
          typeof node.rawValue === 'string' ? node.rawValue : node.preview
        }`}
        style={{ paddingLeft: `${8 + node.depth * 14}px` }}
        className={`group flex items-center gap-1.5 pr-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800/70 text-slate-700 dark:text-slate-300 ${
          hasChildren ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(node.id);
            }}
            aria-label={isCollapsed ? '展开节点' : '折叠节点'}
            className="p-0.5 -ml-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer shrink-0"
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

        <span className="font-code font-medium text-slate-800 dark:text-slate-200 shrink-0 max-w-[45%] truncate">
          {node.key}
        </span>

        <span className={`font-code truncate text-[11px] ml-0.5 ${RESULT_TYPE_COLOR[node.type]}`}>
          {node.preview}
        </span>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCopyNodeValue(node);
          }}
          title={`复制 ${node.key} 的值`}
          className="ml-auto opacity-0 group-hover:opacity-100 p-0.5 rounded text-slate-400 hover:text-blue-600 dark:hover:text-sky-400 hover:bg-slate-200/70 dark:hover:bg-slate-700/70 transition-opacity cursor-pointer shrink-0"
        >
          <Copy className="w-3 h-3" />
        </button>
      </div>

      {hasChildren && !isCollapsed && (
        <div>
          {node.children!.map((child) => (
            <ResultTreeRow
              key={child.id}
              node={child}
              collapsedIds={collapsedIds}
              onToggleCollapse={onToggleCollapse}
              onCopyNodeValue={onCopyNodeValue}
            />
          ))}
        </div>
      )}
    </div>
  );
});

const CONDITION_OPTIONS: Array<{ value: ConditionType; label: string; needsKey: boolean; needsValue: boolean }> = [
  { value: 'keyExists', label: '存在指定 Key', needsKey: true, needsValue: false },
  { value: 'keyNotExists', label: '不存在指定 Key', needsKey: true, needsValue: false },
  { value: 'keyEquals', label: 'Key 的值等于', needsKey: true, needsValue: true },
  { value: 'keyNotEquals', label: 'Key 的值不等于', needsKey: true, needsValue: true },
  { value: 'keyContains', label: 'Key 的值包含', needsKey: true, needsValue: true },
  { value: 'keyGt', label: 'Key 的值大于 (>)', needsKey: true, needsValue: true },
  { value: 'keyGte', label: 'Key 的值 ≥', needsKey: true, needsValue: true },
  { value: 'keyLt', label: 'Key 的值小于 (<)', needsKey: true, needsValue: true },
  { value: 'keyLte', label: 'Key 的值 ≤', needsKey: true, needsValue: true },
  { value: 'anyValueEquals', label: '任意 Value 等于', needsKey: false, needsValue: true },
  { value: 'anyValueContains', label: '任意 Value 包含', needsKey: false, needsValue: true },
];

let condSeq = 1;

export const DataExtractPanel = memo(function DataExtractPanel({
  parsedData,
  isValidJson,
  docName,
  onOpenAsNewDoc,
  onNotify,
}: DataExtractPanelProps) {
  const [mode, setMode] = useState<ExtractMode>('visual');
  const [resultView, setResultView] = useState<ResultViewTab>('json');
  const [resultTreeCollapsed, setResultTreeCollapsed] = useState<Set<string>>(() => new Set());
  const [showSyntaxHelp, setShowSyntaxHelp] = useState(false);
  const [copied, setCopied] = useState(false);

  const discoveredArrays = useMemo(
    () => (isValidJson && parsedData !== undefined ? discoverArrays(parsedData) : []),
    [isValidJson, parsedData]
  );

  const [visualConfig, setVisualConfig] = useState<VisualExtractConfig>(() => ({
    arrayPath: 'items',
    logic: 'and',
    conditions: [
      {
        id: `cond-${condSeq++}`,
        type: 'keyExists',
        key: '',
        value: '',
      },
    ],
    projectionMode: 'full',
    singleKey: '',
    selectedKeys: [],
    deduplicate: false,
  }));

  const [customExpr, setCustomExpr] = useState<string>('');
  const [customKeyDraft, setCustomKeyDraft] = useState<string>('');

  // Auto-sync initial arrayPath when switching documents if current path doesn't exist
  useEffect(() => {
    if (discoveredArrays.length === 0) return;
    const exists = discoveredArrays.some((a) => a.path === visualConfig.arrayPath);
    if (!exists) {
      const first = discoveredArrays[0];
      setVisualConfig((prev) => ({
        ...prev,
        arrayPath: first.path,
        selectedKeys: first.sampleKeys.slice(0, 2),
        singleKey: first.sampleKeys[0] ?? '',
        conditions: [
          {
            id: `cond-${condSeq++}`,
            type: 'keyExists',
            key: first.sampleKeys[0] ?? '',
            value: '',
          },
        ],
      }));
    }
  }, [discoveredArrays, visualConfig.arrayPath]);

  const activeArrayInfo = useMemo(
    () => discoveredArrays.find((a) => a.path === visualConfig.arrayPath) ?? discoveredArrays[0] ?? null,
    [discoveredArrays, visualConfig.arrayPath]
  );

  const generatedExpr = useMemo(
    () => visualConfigToExpression(visualConfig),
    [visualConfig]
  );

  // Initialize expression box with generated expression if blank
  useEffect(() => {
    if (!customExpr && generatedExpr) {
      setCustomExpr(generatedExpr);
    }
  }, [customExpr, generatedExpr]);

  const effectiveExpression = mode === 'visual' ? generatedExpr : customExpr;

  const extractResult = useMemo(() => {
    if (!isValidJson || parsedData === undefined) {
      return null;
    }
    return runExtractExpression(parsedData, effectiveExpression, {
      deduplicate: visualConfig.deduplicate,
    });
  }, [isValidJson, parsedData, effectiveExpression, visualConfig.deduplicate]);

  const formattedOutput = useMemo(() => {
    if (!extractResult?.ok) return '';
    try {
      return JSON.stringify(extractResult.data, null, 2) ?? 'undefined';
    } catch {
      return String(extractResult.data);
    }
  }, [extractResult]);

  const resultTree = useMemo(() => {
    if (!extractResult?.ok || resultView !== 'tree') {
      return { nodes: [] as ResultTreeNode[], totalNodes: 0 };
    }
    return buildResultTree(extractResult.data);
  }, [extractResult, resultView]);

  // Auto-collapse deeper branches when extracted result tree is large
  useEffect(() => {
    if (resultTree.totalNodes > 80 && resultTree.nodes.length > 0) {
      const next = new Set<string>();
      collectResultTreeDeepIds(resultTree.nodes, 2, next);
      setResultTreeCollapsed(next);
    } else {
      setResultTreeCollapsed(new Set());
    }
  }, [resultTree]);

  const toggleResultTreeNode = useCallback((id: string) => {
    setResultTreeCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExpandResultTree = useCallback(() => {
    setResultTreeCollapsed(new Set());
  }, []);

  const handleCollapseResultTree = useCallback(() => {
    if (resultTree.nodes.length === 0) return;
    const next = new Set<string>();
    collectResultTreeDeepIds(resultTree.nodes, 1, next);
    setResultTreeCollapsed(next);
  }, [resultTree.nodes]);

  const handleCopyResultTreeNode = useCallback(
    async (node: ResultTreeNode) => {
      try {
        const text =
          typeof node.rawValue === 'string'
            ? node.rawValue
            : JSON.stringify(node.rawValue, null, 2) ?? String(node.rawValue);
        await navigator.clipboard.writeText(text);
        onNotify?.(`已复制 ${node.path} 的值`);
      } catch {
        onNotify?.('复制失败');
      }
    },
    [onNotify]
  );

  const suggestions = useMemo(
    () => buildSuggestedExpressions(discoveredArrays),
    [discoveredArrays]
  );

  const updateCondition = (id: string, patch: Partial<VisualCondition>) => {
    setVisualConfig((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  const addCondition = () => {
    setVisualConfig((prev) => ({
      ...prev,
      conditions: [
        ...prev.conditions,
        {
          id: `cond-${condSeq++}`,
          type: 'keyEquals',
          key: activeArrayInfo?.sampleKeys[0] ?? '',
          value: '',
        },
      ],
    }));
  };

  const removeCondition = (id: string) => {
    setVisualConfig((prev) => ({
      ...prev,
      conditions: prev.conditions.filter((c) => c.id !== id),
    }));
  };

  const toggleProjectedKey = (keyName: string) => {
    setVisualConfig((prev) => {
      const exists = prev.selectedKeys.includes(keyName);
      return {
        ...prev,
        selectedKeys: exists
          ? prev.selectedKeys.filter((k) => k !== keyName)
          : [...prev.selectedKeys, keyName],
      };
    });
  };

  const handleAddCustomKey = () => {
    const trimmed = customKeyDraft.trim();
    if (!trimmed) return;
    if (!visualConfig.selectedKeys.includes(trimmed)) {
      setVisualConfig((prev) => ({
        ...prev,
        selectedKeys: [...prev.selectedKeys, trimmed],
      }));
    }
    setCustomKeyDraft('');
  };

  const handleCopyResult = async () => {
    if (!formattedOutput) return;
    try {
      await navigator.clipboard.writeText(formattedOutput);
      setCopied(true);
      onNotify?.('已复制提取结果');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      onNotify?.('复制失败，请手动复制');
    }
  };

  const handleExportResult = () => {
    if (!formattedOutput) return;
    const base = docName.replace(/\.[^.]+$/, '');
    const outName = `${base}_extracted.json`;
    const blob = new Blob([formattedOutput], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onNotify?.(`已导出 ${outName}`);
  };

  const handleOpenAsNewDoc = () => {
    if (!formattedOutput) return;
    const base = docName.replace(/\.[^.]+$/, '');
    onOpenAsNewDoc(`${base}_extracted.json`, formattedOutput);
  };

  if (!isValidJson) {
    return (
      <div className="p-5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed space-y-2">
        <div className="font-medium text-slate-700 dark:text-slate-200">
          当前文档暂不支持数据提取
        </div>
        <p>
          请确保当前文档为语法有效的 JSON 或 JSONC 格式，修复语法错误后即可实时筛选并提取数组中的目标数据。
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Mode Switcher: Visual Builder vs Expression Input */}
      <div className="shrink-0 px-3 pt-2.5 pb-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1 p-0.5 rounded-md bg-slate-200/70 dark:bg-slate-800">
          <button
            type="button"
            onClick={() => setMode('visual')}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap cursor-pointer ${
              mode === 'visual'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <SlidersHorizontal className="w-3 h-3" />
            <span>可视化条件</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setCustomExpr(generatedExpr);
              setMode('expression');
            }}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap cursor-pointer ${
              mode === 'expression'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Code2 className="w-3 h-3" />
            <span>表达式</span>
          </button>
        </div>

        <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400 cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={visualConfig.deduplicate}
            onChange={(e) =>
              setVisualConfig((prev) => ({ ...prev, deduplicate: e.target.checked }))
            }
            className="rounded border-slate-300 dark:border-slate-700 accent-blue-600"
          />
          <span>结果去重</span>
        </label>
      </div>

      {/* Scrollable Rule / Expression Config Area */}
      <div className="shrink-0 max-h-[54%] overflow-y-auto px-3 py-3 space-y-3 border-b border-slate-200 dark:border-slate-800">
        {mode === 'visual' ? (
          <>
            {/* 1. Target Array Path */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
                  目标数组路径
                </label>
                {activeArrayInfo && (
                  <span className="text-[11px] font-code tabular-nums text-slate-400">
                    共 {activeArrayInfo.length} 项
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {discoveredArrays.length > 0 ? (
                  <select
                    value={
                      discoveredArrays.some((a) => a.path === visualConfig.arrayPath)
                        ? visualConfig.arrayPath
                        : '__custom__'
                    }
                    onChange={(e) => {
                      if (e.target.value !== '__custom__') {
                        const targetArr = discoveredArrays.find((a) => a.path === e.target.value);
                        setVisualConfig((prev) => ({
                          ...prev,
                          arrayPath: e.target.value,
                          singleKey: targetArr?.sampleKeys[0] ?? '',
                          selectedKeys: targetArr ? targetArr.sampleKeys.slice(0, 2) : [],
                        }));
                      }
                    }}
                    className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-code text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500"
                  >
                    {discoveredArrays.map((arr) => (
                      <option key={arr.path} value={arr.path}>
                        {arr.path === '$' ? '$ (根数组)' : arr.path} ({arr.length} 项)
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={visualConfig.arrayPath}
                    onChange={(e) =>
                      setVisualConfig((prev) => ({ ...prev, arrayPath: e.target.value }))
                    }
                    placeholder="如 items 或 $"
                    className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-code text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500"
                  />
                )}
              </div>
            </div>

            {/* 2. Filter Conditions */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-400">
                  <Filter className="w-3 h-3" />
                  <span>筛选条件</span>
                </span>
                <div className="flex items-center gap-2">
                  {visualConfig.conditions.length > 1 && (
                    <div className="inline-flex items-center rounded border border-slate-200 dark:border-slate-700 overflow-hidden text-[10px]">
                      <button
                        type="button"
                        onClick={() => setVisualConfig((p) => ({ ...p, logic: 'and' }))}
                        className={`px-1.5 py-0.5 cursor-pointer ${
                          visualConfig.logic === 'and'
                            ? 'bg-blue-600 text-white'
                            : 'bg-white dark:bg-slate-900 text-slate-500'
                        }`}
                      >
                        且 AND
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisualConfig((p) => ({ ...p, logic: 'or' }))}
                        className={`px-1.5 py-0.5 cursor-pointer ${
                          visualConfig.logic === 'or'
                            ? 'bg-blue-600 text-white'
                            : 'bg-white dark:bg-slate-900 text-slate-500'
                        }`}
                      >
                        或 OR
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={addCondition}
                    className="inline-flex items-center gap-0.5 text-[11px] font-medium text-blue-600 dark:text-sky-400 hover:underline cursor-pointer whitespace-nowrap"
                  >
                    <Plus className="w-3 h-3" />
                    <span>添加条件</span>
                  </button>
                </div>
              </div>

              {/* Datalist of auto-detected keys for fast autocomplete */}
              <datalist id="extract-detected-keys">
                {(activeArrayInfo?.sampleKeys ?? []).map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>

              {visualConfig.conditions.length === 0 ? (
                <div className="text-[11px] text-slate-400 py-1">
                  未设置筛选条件，将匹配数组中所有元素
                </div>
              ) : (
                <div className="space-y-2">
                  {visualConfig.conditions.map((cond) => {
                    const meta =
                      CONDITION_OPTIONS.find((o) => o.value === cond.type) ?? CONDITION_OPTIONS[0];
                    return (
                      <div
                        key={cond.id}
                        className="p-2 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 space-y-1.5"
                      >
                        <div className="flex items-center gap-1.5">
                          <select
                            value={cond.type}
                            onChange={(e) =>
                              updateCondition(cond.id, { type: e.target.value as ConditionType })
                            }
                            className="flex-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-[11px] text-slate-800 dark:text-slate-200 outline-none focus:border-blue-500"
                          >
                            {CONDITION_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => removeCondition(cond.id)}
                            title="移除条件"
                            className="p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        <div className="flex items-center gap-1.5">
                          {meta.needsKey && (
                            <input
                              type="text"
                              list="extract-detected-keys"
                              value={cond.key}
                              onChange={(e) => updateCondition(cond.id, { key: e.target.value })}
                              placeholder="键名 (支持嵌套如 specs.firmware)"
                              className="flex-1 min-w-0 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-code text-slate-900 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:border-blue-500"
                            />
                          )}
                          {meta.needsValue && (
                            <input
                              type="text"
                              value={cond.value}
                              onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                              placeholder={
                                meta.needsKey ? '目标值 (如 100 / true)' : '任意字段包含的目标值'
                              }
                              className="flex-1 min-w-0 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-code text-slate-900 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:border-blue-500"
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 3. Custom Extraction Output */}
            <div className="space-y-2">
              <span className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                自定义提取内容
              </span>
              <div className="grid grid-cols-3 gap-1 p-0.5 rounded-md bg-slate-200/70 dark:bg-slate-800">
                {(
                  [
                    { id: 'full', label: '完整对象' },
                    { id: 'singleKey', label: '单个 Key 值' },
                    { id: 'multiKeys', label: '多个指定 Key' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      setVisualConfig((prev) => ({ ...prev, projectionMode: item.id }))
                    }
                    className={`px-2 py-1 rounded text-[11px] font-medium whitespace-nowrap cursor-pointer ${
                      visualConfig.projectionMode === item.id
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {visualConfig.projectionMode === 'singleKey' && (
                <input
                  type="text"
                  list="extract-detected-keys"
                  value={visualConfig.singleKey}
                  onChange={(e) =>
                    setVisualConfig((prev) => ({ ...prev, singleKey: e.target.value }))
                  }
                  placeholder="输入要提取的 Key，如 sku 或 specs.firmware.channel"
                  className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-code text-slate-900 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:border-blue-500"
                />
              )}

              {visualConfig.projectionMode === 'multiKeys' && (
                <div className="space-y-2">
                  {/* Detected key toggle buttons */}
                  {activeArrayInfo && activeArrayInfo.sampleKeys.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {activeArrayInfo.sampleKeys.slice(0, 14).map((k) => {
                        const selected = visualConfig.selectedKeys.includes(k);
                        return (
                          <button
                            key={k}
                            type="button"
                            onClick={() => toggleProjectedKey(k)}
                            className={`px-2 py-0.5 rounded text-[11px] font-code border cursor-pointer ${
                              selected
                                ? 'bg-blue-600 border-blue-600 text-white'
                                : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-400'
                            }`}
                          >
                            {k}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Custom key or alias input */}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      list="extract-detected-keys"
                      value={customKeyDraft}
                      onChange={(e) => setCustomKeyDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddCustomKey();
                        }
                      }}
                      placeholder="添加路径或别名 (如 price: unitPrice)"
                      className="flex-1 min-w-0 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-code text-slate-900 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={handleAddCustomKey}
                      className="px-2.5 py-1 rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap cursor-pointer"
                    >
                      添加
                    </button>
                  </div>

                  {visualConfig.selectedKeys.length > 0 && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center justify-between gap-2">
                      <span className="truncate font-code">
                        已选：{visualConfig.selectedKeys.join(', ')}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setVisualConfig((prev) => ({ ...prev, selectedKeys: [] }))
                        }
                        className="text-slate-400 hover:text-red-500 shrink-0 cursor-pointer"
                      >
                        清空
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Generated Expression Preview */}
            <div className="pt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="truncate font-code text-slate-700 dark:text-slate-300" title={generatedExpr}>
                {generatedExpr}
              </span>
              <button
                type="button"
                onClick={() => {
                  setCustomExpr(generatedExpr);
                  setMode('expression');
                }}
                className="text-blue-600 dark:text-sky-400 hover:underline shrink-0 cursor-pointer whitespace-nowrap"
              >
                编辑表达式
              </button>
            </div>
          </>
        ) : (
          /* Expression Mode */
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
                数据提取表达式
              </label>
              <button
                type="button"
                onClick={() => setShowSyntaxHelp((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-sky-400 hover:underline cursor-pointer"
              >
                <HelpCircle className="w-3 h-3" />
                <span>{showSyntaxHelp ? '收起语法' : '语法说明'}</span>
              </button>
            </div>

            <textarea
              value={customExpr}
              onChange={(e) => setCustomExpr(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder='示例：items[unitPrice >= 500 && has(specs.firmware)].{sku, title}'
              className="w-full p-2.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-code leading-relaxed text-slate-900 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:border-blue-500 resize-y"
            />

            {showSyntaxHelp && (
              <div className="p-2.5 rounded-md bg-slate-100/80 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[11px] space-y-1.5 text-slate-600 dark:text-slate-300">
                <div>
                  <span className="font-code text-blue-700 dark:text-sky-300">items[has(specs.firmware)]</span>
                  <span className="ml-1.5 text-slate-500">存在指定 Key</span>
                </div>
                <div>
                  <span className="font-code text-blue-700 dark:text-sky-300">items[unitPrice &gt;= 500]</span>
                  <span className="ml-1.5 text-slate-500">Key 值比较 (== != &gt; &lt; ~=)</span>
                </div>
                <div>
                  <span className="font-code text-blue-700 dark:text-sky-300">messages[content[1].close == &quot;user&quot;].content</span>
                  <span className="ml-1.5 text-slate-500">嵌套数组指定下标匹配</span>
                </div>
                <div>
                  <span className="font-code text-blue-700 dark:text-sky-300">messages[content[*].close == &quot;user&quot;].content</span>
                  <span className="ml-1.5 text-slate-500">嵌套数组任意元素匹配</span>
                </div>
                <div>
                  <span className="font-code text-blue-700 dark:text-sky-300">items[hasValue(&quot;RS485&quot;)] / items[$value ~= &quot;工业&quot;]</span>
                  <span className="ml-1.5 text-slate-500">任意 Value 等于 / 包含</span>
                </div>
                <div>
                  <span className="font-code text-blue-700 dark:text-sky-300">.sku / .&#123;sku, price: unitPrice&#125;</span>
                  <span className="ml-1.5 text-slate-500">提取单个或多个指定键</span>
                </div>
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] text-slate-400">快捷示例（点击填入）：</div>
                <div className="space-y-1">
                  {suggestions.map((s) => (
                    <button
                      key={s.expr}
                      type="button"
                      onClick={() => setCustomExpr(s.expr)}
                      className="w-full text-left px-2 py-1.5 rounded border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-950 hover:border-blue-400 dark:hover:border-sky-600 cursor-pointer"
                    >
                      <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                        {s.label}
                      </div>
                      <div className="text-[11px] font-code text-blue-600 dark:text-sky-400 truncate">
                        {s.expr}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Live Extracted Result Header + View Tabs + Actions */}
      <div className="shrink-0 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-900/80 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {extractResult?.ok ? (
            <>
              <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-slate-200/80 dark:bg-slate-800 shrink-0">
                <button
                  type="button"
                  onClick={() => setResultView('json')}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap cursor-pointer ${
                    resultView === 'json'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <Braces className="w-3 h-3 shrink-0" />
                  <span>JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => setResultView('tree')}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap cursor-pointer ${
                    resultView === 'tree'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <ListTree className="w-3 h-3 shrink-0" />
                  <span>结构树</span>
                </button>
              </div>

              {extractResult.matchedCount !== undefined && (
                <span className="font-code text-[11px] tabular-nums text-blue-600 dark:text-sky-400 truncate">
                  {extractResult.matchedCount}
                  {extractResult.sourceCount !== undefined
                    ? ` / ${extractResult.sourceCount} 项`
                    : ' 项'}
                </span>
              )}
            </>
          ) : (
            <span className="text-xs font-medium text-red-600 dark:text-red-400 truncate">
              表达式错误
            </span>
          )}
        </div>

        {extractResult?.ok && (
          <div className="flex items-center gap-0.5 shrink-0">
            {resultView === 'tree' && (
              <>
                <button
                  type="button"
                  onClick={handleExpandResultTree}
                  disabled={resultTreeCollapsed.size === 0}
                  title="展开全部结果节点"
                  className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
                >
                  <ChevronsUpDown className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleCollapseResultTree}
                  title="折叠结果子节点"
                  className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <ChevronsDownUp className="w-3.5 h-3.5" />
                </button>
                <span
                  aria-hidden="true"
                  className="h-3.5 w-px bg-slate-300 dark:bg-slate-700 mx-0.5"
                />
              </>
            )}
            <button
              type="button"
              onClick={handleCopyResult}
              title="复制提取结果"
              className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={handleOpenAsNewDoc}
              title="作为新文档在编辑器中打开"
              className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
            >
              <FilePlus2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleExportResult}
              title="导出提取结果为 JSON 文件"
              className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Extracted Result Body: JSON or Interactive Structure Tree */}
      <div className="flex-1 overflow-auto bg-white dark:bg-slate-950 min-h-0">
        {extractResult?.ok ? (
          resultView === 'json' ? (
            <pre className="m-0 p-3 text-xs font-code leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">
              {formattedOutput}
            </pre>
          ) : (
            <div className="py-1.5">
              {resultTree.nodes.map((rootNode) => (
                <ResultTreeRow
                  key={rootNode.id}
                  node={rootNode}
                  collapsedIds={resultTreeCollapsed}
                  onToggleCollapse={toggleResultTreeNode}
                  onCopyNodeValue={handleCopyResultTreeNode}
                />
              ))}
            </div>
          )
        ) : (
          <div className="p-3 text-xs text-red-600 dark:text-red-400 leading-relaxed">
            {extractResult?.error ?? '请输入有效表达式'}
          </div>
        )}
      </div>
    </div>
  );
});
