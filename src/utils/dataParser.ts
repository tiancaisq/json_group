import { BracketAnalysis, DataFormat, StructureNode, ValidationResult } from '../types/editor';
import { offsetToLineCol } from './bracketMatcher';

/**
 * Strip single-line (//) and block comments while preserving exact line/character offsets
 * by replacing comment characters with spaces (preserving newlines).
 */
export function stripCommentsPreservingOffsets(text: string): string {
  if (!text.includes('//') && !text.includes('/*')) {
    return text;
  }

  const len = text.length;
  const parts: string[] = [];
  let lastEmit = 0;
  let i = 0;
  let inString = false;

  while (i < len) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      parts.push(text.slice(lastEmit, i));
      const start = i;
      i += 2;
      while (i < len && text[i] !== '\n') i++;
      parts.push(' '.repeat(i - start));
      lastEmit = i;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      parts.push(text.slice(lastEmit, i));
      let buf = '  ';
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        buf += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < len) {
        buf += '  ';
        i += 2;
      }
      parts.push(buf);
      lastEmit = i;
      continue;
    }

    i++;
  }

  if (lastEmit === 0) return text;
  parts.push(text.slice(lastEmit));
  return parts.join('');
}

export function validateData(
  text: string,
  format: DataFormat,
  analysis: BracketAnalysis
): ValidationResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { valid: true, message: '空文档' };
  }

  // Always check unmatched brackets first across all formats
  if (analysis.unmatched.length > 0) {
    const first = analysis.unmatched[0];
    return {
      valid: false,
      message: `第 ${first.line} 行存在未匹配的括号 "${first.char}"`,
      errorLine: first.line,
      errorCol: first.col,
      errorOffset: first.index,
    };
  }

  if (format === 'expression') {
    return {
      valid: true,
      message: `括号匹配完整（共 ${analysis.pairs.length} 组）`,
    };
  }

  const parseSource =
    format === 'jsonc' ? stripCommentsPreservingOffsets(text) : text;

  try {
    const parsed = JSON.parse(parseSource);
    return {
      valid: true,
      message: format === 'jsonc' ? 'JSONC 语法有效' : 'JSON 语法有效',
      parsedValue: parsed,
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : '语法解析错误';

    // Try extracting position from V8 / Safari / Firefox error messages
    let errorOffset: number | undefined;
    let errorLine: number | undefined;
    let errorCol: number | undefined;

    const posMatch = rawMsg.match(/position\s+(\d+)/i);
    if (posMatch) {
      errorOffset = Number(posMatch[1]);
      const lc = offsetToLineCol(analysis.lineStarts, Math.min(errorOffset, text.length));
      errorLine = lc.line;
      errorCol = lc.col;
    } else {
      const lcMatch = rawMsg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
      if (lcMatch) {
        errorLine = Number(lcMatch[1]);
        errorCol = Number(lcMatch[2]);
        const lineStart = analysis.lineStarts[errorLine - 1] ?? 0;
        errorOffset = lineStart + Math.max(0, errorCol - 1);
      }
    }

    return {
      valid: false,
      message: errorLine
        ? `第 ${errorLine} 行第 ${errorCol} 列语法错误`
        : `语法错误：${rawMsg.replace(/^JSON\.parse:\s*/i, '')}`,
      errorLine,
      errorCol,
      errorOffset,
    };
  }
}

export function formatJsonText(text: string, format: DataFormat, indent = 2): { ok: boolean; result: string; error?: string } {
  if (format === 'expression') {
    return {
      ok: false,
      result: text,
      error: '表达式模式不支持自动 JSON 格式化，请切换至 JSON 模式',
    };
  }
  try {
    const source = format === 'jsonc' ? stripCommentsPreservingOffsets(text) : text;
    const parsed = JSON.parse(source);
    return {
      ok: true,
      result: JSON.stringify(parsed, null, indent),
    };
  } catch {
    return {
      ok: false,
      result: text,
      error: '存在语法错误，无法格式化，请先修复高亮位置的语法问题',
    };
  }
}

export function minifyJsonText(text: string, format: DataFormat): { ok: boolean; result: string; error?: string } {
  if (format === 'expression') {
    return {
      ok: false,
      result: text,
      error: '表达式模式不支持 JSON 压缩',
    };
  }
  try {
    const source = format === 'jsonc' ? stripCommentsPreservingOffsets(text) : text;
    const parsed = JSON.parse(source);
    return {
      ok: true,
      result: JSON.stringify(parsed),
    };
  } catch {
    return {
      ok: false,
      result: text,
      error: '存在语法错误，无法压缩',
    };
  }
}

function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort((a, b) =>
      a.localeCompare(b, 'zh-CN')
    )) {
      sorted[k] = deepSortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export function sortJsonKeysText(text: string, format: DataFormat): { ok: boolean; result: string; error?: string } {
  if (format === 'expression') {
    return {
      ok: false,
      result: text,
      error: '表达式模式不支持键名排序',
    };
  }
  try {
    const source = format === 'jsonc' ? stripCommentsPreservingOffsets(text) : text;
    const parsed = JSON.parse(source);
    return {
      ok: true,
      result: JSON.stringify(deepSortKeys(parsed), null, 2),
    };
  } catch {
    return {
      ok: false,
      result: text,
      error: '存在语法错误，无法执行键名排序',
    };
  }
}

/**
 * Lightweight recursive descent JSON/JSONC parser that preserves exact
 * source offsets for every node so clicking in the Structure Tree jumps
 * directly to that node's opening bracket or value in the editor.
 */
export function buildStructureTree(
  text: string,
  format: DataFormat,
  lineStarts: number[]
): StructureNode[] {
  if (format === 'expression') return [];
  const src = format === 'jsonc' ? stripCommentsPreservingOffsets(text) : text;
  const len = src.length;
  let pos = 0;
  let nodeSeq = 0;

  const skipWs = () => {
    while (pos < len && (src[pos] === ' ' || src[pos] === '\t' || src[pos] === '\n' || src[pos] === '\r')) {
      pos++;
    }
  };

  const readString = (): string => {
    const start = pos;
    pos++; // skip opening "
    while (pos < len) {
      if (src[pos] === '\\') {
        pos += 2;
        continue;
      }
      if (src[pos] === '"') {
        pos++;
        break;
      }
      pos++;
    }
    try {
      return JSON.parse(src.slice(start, pos));
    } catch {
      return src.slice(start + 1, Math.max(start + 1, pos - 1));
    }
  };

  const parseValue = (key: string, depth: number, keyOffset?: number): StructureNode | null => {
    skipWs();
    if (pos >= len) return null;
    const startOffset = pos;
    const startLine = offsetToLineCol(lineStarts, startOffset).line;
    const ch = src[pos];
    const id = `node-${++nodeSeq}`;

    if (ch === '{') {
      pos++;
      const children: StructureNode[] = [];
      skipWs();
      if (src[pos] === '}') {
        pos++;
      } else {
        while (pos < len) {
          skipWs();
          if (src[pos] !== '"') return null;
          const propKeyOffset = pos;
          const propKey = readString();
          skipWs();
          if (src[pos] !== ':') return null;
          pos++;
          const child = parseValue(propKey, depth + 1, propKeyOffset);
          if (!child) return null;
          children.push(child);
          skipWs();
          if (src[pos] === ',') {
            pos++;
            continue;
          }
          if (src[pos] === '}') {
            pos++;
            break;
          }
          return null;
        }
      }
      const endOffset = pos - 1;
      const endLine = offsetToLineCol(lineStarts, endOffset).line;
      return {
        id,
        key,
        type: 'object',
        preview: `{ ${children.length} 项 }`,
        keyOffset,
        offset: startOffset,
        endOffset,
        line: startLine,
        endLine,
        depth,
        childCount: children.length,
        children,
      };
    }

    if (ch === '[') {
      pos++;
      const children: StructureNode[] = [];
      skipWs();
      if (src[pos] === ']') {
        pos++;
      } else {
        let idx = 0;
        while (pos < len) {
          const child = parseValue(`[${idx}]`, depth + 1);
          if (!child) return null;
          children.push(child);
          idx++;
          skipWs();
          if (src[pos] === ',') {
            pos++;
            continue;
          }
          if (src[pos] === ']') {
            pos++;
            break;
          }
          return null;
        }
      }
      const endOffset = pos - 1;
      const endLine = offsetToLineCol(lineStarts, endOffset).line;
      return {
        id,
        key,
        type: 'array',
        preview: `[ ${children.length} 项 ]`,
        keyOffset,
        offset: startOffset,
        endOffset,
        line: startLine,
        endLine,
        depth,
        childCount: children.length,
        children,
      };
    }

    if (ch === '"') {
      const val = readString();
      const endOffset = pos - 1;
      const endLine = offsetToLineCol(lineStarts, endOffset).line;
      const truncated = val.length > 28 ? `${val.slice(0, 28)}…` : val;
      return {
        id,
        key,
        type: 'string',
        preview: `"${truncated}"`,
        keyOffset,
        offset: startOffset,
        endOffset,
        line: startLine,
        endLine,
        depth,
        childCount: 0,
      };
    }

    // Primitive: number, boolean, null
    const primStart = pos;
    while (
      pos < len &&
      src[pos] !== ',' &&
      src[pos] !== '}' &&
      src[pos] !== ']' &&
      src[pos] !== ' ' &&
      src[pos] !== '\t' &&
      src[pos] !== '\n' &&
      src[pos] !== '\r'
    ) {
      pos++;
    }
    const raw = src.slice(primStart, pos);
    const endOffset = Math.max(startOffset, pos - 1);
    const endLine = offsetToLineCol(lineStarts, endOffset).line;

    if (raw === 'true' || raw === 'false') {
      return {
        id,
        key,
        type: 'boolean',
        preview: raw,
        keyOffset,
        offset: startOffset,
        endOffset,
        line: startLine,
        endLine,
        depth,
        childCount: 0,
      };
    }
    if (raw === 'null') {
      return {
        id,
        key,
        type: 'null',
        preview: 'null',
        keyOffset,
        offset: startOffset,
        endOffset,
        line: startLine,
        endLine,
        depth,
        childCount: 0,
      };
    }
    if (raw && !Number.isNaN(Number(raw))) {
      return {
        id,
        key,
        type: 'number',
        preview: raw,
        keyOffset,
        offset: startOffset,
        endOffset,
        line: startLine,
        endLine,
        depth,
        childCount: 0,
      };
    }

    return null;
  };

  const root = parseValue('root', 0);
  return root ? [root] : [];
}

export interface StructureLocateResult {
  node: StructureNode;
  ancestorIds: string[];
  path: string;
}

function formatPathSegment(parentPath: string, key: string): string {
  if (!parentPath) return key;
  if (/^\[\d+\]$/.test(key)) return `${parentPath}${key}`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parentPath}.${key}`;
  return `${parentPath}[${JSON.stringify(key)}]`;
}

/**
 * Locate the deepest StructureNode containing the given editor cursor offset
 * (falling back gracefully to right-edge boundaries and same-line entries).
 */
export function findStructureNodeAtOffset(
  roots: StructureNode[],
  cursorOffset: number,
  cursorLine?: number
): StructureLocateResult | null {
  if (roots.length === 0) return null;

  const findInList = (
    nodes: StructureNode[],
    allowLineFallback: boolean
  ): StructureNode | null => {
    for (const node of nodes) {
      const start = node.keyOffset ?? node.offset;
      if (cursorOffset >= start && cursorOffset <= node.endOffset) {
        return node;
      }
    }

    for (const node of nodes) {
      const start = node.keyOffset ?? node.offset;
      if (cursorOffset >= start && cursorOffset <= node.endOffset + 1) {
        return node;
      }
    }

    if (allowLineFallback && cursorLine !== undefined) {
      let best: StructureNode | null = null;
      let bestDist = Infinity;
      for (const node of nodes) {
        if (cursorLine >= node.line && cursorLine <= node.endLine) {
          const start = node.keyOffset ?? node.offset;
          const dist =
            cursorOffset < start
              ? start - cursorOffset
              : cursorOffset > node.endOffset
              ? cursorOffset - node.endOffset
              : 0;
          if (dist < bestDist) {
            bestDist = dist;
            best = node;
          }
        }
      }
      if (best) return best;
    }

    return null;
  };

  const ancestorIds: string[] = [];
  let path = '';
  let current = findInList(roots, true) ?? roots[0];

  while (current) {
    path = formatPathSegment(path, current.key);
    if (!current.children || current.children.length === 0) {
      return { node: current, ancestorIds, path };
    }

    const allowChildLineFallback =
      current.endLine > current.line &&
      cursorOffset > current.offset &&
      cursorOffset < current.endOffset;

    const child = findInList(current.children, allowChildLineFallback);
    if (!child) {
      return { node: current, ancestorIds, path };
    }

    ancestorIds.push(current.id);
    current = child;
  }

  return null;
}
