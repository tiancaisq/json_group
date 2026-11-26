import React, { memo, useEffect, useRef, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { HistorySnapshot } from '../types/editor';

interface HistoryMenuProps {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
  currentLineCount: number;
  currentCharCount: number;
  onRollbackToPastIndex: (pastIndex: number) => void;
  onAdvanceToFutureIndex: (futureIndex: number) => void;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

export const HistoryMenu = memo(function HistoryMenu({
  past,
  future,
  currentLineCount,
  currentCharCount,
  onRollbackToPastIndex,
  onAdvanceToFutureIndex,
}: HistoryMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const totalSteps = past.length + future.length;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={totalSteps === 0}
        title="查看历史记录并回退到任意版本"
        className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed ${
          open
            ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-sky-300'
            : 'text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800'
        }`}
      >
        <History className="w-3.5 h-3.5 shrink-0" />
        <span className="hidden md:inline">历史回退</span>
        {past.length > 0 && (
          <span className="font-code text-[11px] tabular-nums opacity-70">{past.length}</span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-40 w-76 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg shadow-slate-900/10 dark:shadow-black/40 overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              编辑历史回退
            </span>
            {past.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onRollbackToPastIndex(0);
                  setOpen(false);
                }}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-sky-400 hover:underline whitespace-nowrap cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>回退到初始状态</span>
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
            {/* Future steps (available for Redo), farthest on top */}
            {future
              .map((snap, idx) => ({ snap, idx }))
              .reverse()
              .map(({ snap, idx }) => (
                <button
                  key={snap.id}
                  type="button"
                  onClick={() => {
                    onAdvanceToFutureIndex(idx);
                    setOpen(false);
                  }}
                  className="w-full px-3.5 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/70 flex items-center justify-between gap-2 cursor-pointer opacity-70 hover:opacity-100"
                >
                  <div className="min-w-0">
                    <div className="text-xs text-slate-600 dark:text-slate-300 truncate">
                      重做至：{snap.label}
                    </div>
                    <div className="text-[11px] font-code tabular-nums text-slate-400">
                      {countLines(snap.content)} 行 · {snap.content.length} 字符
                    </div>
                  </div>
                  <span className="font-code text-[11px] tabular-nums text-slate-400 shrink-0">
                    {formatClock(snap.timestamp)}
                  </span>
                </button>
              ))}

            {/* Current state */}
            <div className="px-3.5 py-2 bg-blue-50/70 dark:bg-blue-500/12 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-blue-700 dark:text-sky-300">
                  当前内容
                </div>
                <div className="text-[11px] font-code tabular-nums text-blue-600/80 dark:text-sky-300/80">
                  {currentLineCount} 行 · {currentCharCount} 字符
                </div>
              </div>
              <span className="text-[11px] text-blue-600 dark:text-sky-400 shrink-0">正在编辑</span>
            </div>

            {/* Past steps (available for Undo / Rollback), most recent first */}
            {past
              .map((snap, idx) => ({ snap, idx }))
              .reverse()
              .map(({ snap, idx }) => (
                <button
                  key={snap.id}
                  type="button"
                  onClick={() => {
                    onRollbackToPastIndex(idx);
                    setOpen(false);
                  }}
                  className="w-full px-3.5 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/70 flex items-center justify-between gap-2 cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                      {idx === 0 ? `初始状态 (${snap.label}前)` : `回退至：${snap.label}前`}
                    </div>
                    <div className="text-[11px] font-code tabular-nums text-slate-400 dark:text-slate-500">
                      {countLines(snap.content)} 行 · {snap.content.length} 字符
                    </div>
                  </div>
                  <span className="font-code text-[11px] tabular-nums text-slate-400 shrink-0">
                    {formatClock(snap.timestamp)}
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
});
