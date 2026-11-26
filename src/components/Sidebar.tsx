import React, { memo, useRef } from 'react';
import { FileCode2, FileJson, FilePlus2, FolderUp, Trash2 } from 'lucide-react';
import { DataDocument, DataFormat } from '../types/editor';

interface SidebarProps {
  documents: DataDocument[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onImport: (name: string, content: string, format: DataFormat) => void;
  onDelete: (id: string) => void;
}

const FORMAT_LABELS: Record<DataFormat, string> = {
  json: 'JSON',
  jsonc: 'JSONC',
  expression: 'EXPR',
};

export const Sidebar = memo(function Sidebar({
  documents,
  activeId,
  onSelect,
  onCreate,
  onImport,
  onDelete,
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      const lower = file.name.toLowerCase();
      let format: DataFormat = 'json';
      if (lower.endsWith('.jsonc')) format = 'jsonc';
      else if (lower.endsWith('.js') || lower.endsWith('.ts') || lower.endsWith('.expr')) {
        format = 'expression';
      }
      onImport(file.name, content, format);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <aside className="w-56 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex flex-col min-h-0">
      {/* File Actions */}
      <div className="shrink-0 px-3 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          工作区文件
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCreate}
            title="新建数据文档"
            className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="导入本地文件"
            className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <FolderUp className="w-3.5 h-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.jsonc,.js,.ts,.txt,.expr"
            onChange={handleFilePick}
            className="hidden"
          />
        </div>
      </div>

      {/* Document List */}
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5 min-h-0">
        {documents.map((doc) => {
          const isActive = doc.id === activeId;
          return (
            <div
              key={doc.id}
              onClick={() => onSelect(doc.id)}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors ${
                isActive
                  ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-sky-300 font-medium'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/70'
              }`}
            >
              {doc.format === 'expression' ? (
                <FileCode2 className="w-3.5 h-3.5 shrink-0 opacity-75" />
              ) : (
                <FileJson className="w-3.5 h-3.5 shrink-0 opacity-75" />
              )}
              <span className="truncate flex-1">{doc.name}</span>
              <span className="font-code text-[10px] text-slate-400 dark:text-slate-500 shrink-0 group-hover:hidden">
                {FORMAT_LABELS[doc.format]}
              </span>
              {documents.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(doc.id);
                  }}
                  title="删除文档"
                  className="hidden group-hover:flex p-0.5 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Compact Keyboard Shortcut Reference */}
      <div className="shrink-0 p-3.5 border-t border-slate-200 dark:border-slate-800 text-xs">
        <div className="font-semibold text-slate-700 dark:text-slate-300 mb-2.5">
          括号跳转快捷键
        </div>
        <dl className="space-y-2 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">跳转匹配括号</dt>
            <dd className="font-code text-slate-800 dark:text-slate-200 tabular-nums whitespace-nowrap">
              Ctrl + M
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">备选跳转键</dt>
            <dd className="font-code text-slate-800 dark:text-slate-200 tabular-nums whitespace-nowrap">
              Ctrl+Shift+\
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">选中整个括号块</dt>
            <dd className="font-code text-slate-800 dark:text-slate-200 tabular-nums whitespace-nowrap">
              Ctrl+Shift+M
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">收缩 / 展开块</dt>
            <dd className="font-code text-slate-800 dark:text-slate-200 tabular-nums whitespace-nowrap">
              Ctrl+Shift+[ / ]
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">撤销 / 重做</dt>
            <dd className="font-code text-slate-800 dark:text-slate-200 tabular-nums whitespace-nowrap">
              Ctrl + Z / Y
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">查找与替换</dt>
            <dd className="font-code text-slate-800 dark:text-slate-200 tabular-nums whitespace-nowrap">
              Ctrl + F / H
            </dd>
          </div>
        </dl>
      </div>
    </aside>
  );
});
