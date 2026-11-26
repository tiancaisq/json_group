export type ConditionType =
  | 'keyExists'
  | 'keyNotExists'
  | 'keyEquals'
  | 'keyNotEquals'
  | 'keyContains'
  | 'keyGt'
  | 'keyGte'
  | 'keyLt'
  | 'keyLte'
  | 'anyValueEquals'
  | 'anyValueContains';

export interface VisualCondition {
  id: string;
  type: ConditionType;
  key: string;
  value: string;
}

export type ProjectionMode = 'full' | 'singleKey' | 'multiKeys';

export interface VisualExtractConfig {
  arrayPath: string; // e.g. "items", "billing.discounts", "$" for root array
  logic: 'and' | 'or';
  conditions: VisualCondition[];
  projectionMode: ProjectionMode;
  singleKey: string;
  selectedKeys: string[]; // supports "key" or "alias: path.to.key"
  deduplicate: boolean;
}

export interface DiscoveredArray {
  path: string;
  length: number;
  objectCount: number;
  sampleKeys: string[];
}

export interface ExtractResult {
  ok: boolean;
  data?: unknown;
  matchedCount?: number;
  sourceCount?: number;
  error?: string;
}

type PathSegment =
  | { kind: 'prop'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'filter'; predicate: string };

export interface PathResolveAllResult {
  exists: boolean;
  values: unknown[];
  isMulti: boolean;
}

/**
 * Find matching closing delimiter index, respecting quoted strings and nested brackets.
 */
function findMatchingDelimiter(src: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inQuote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse a path with dot properties, numeric array indices ([1], [-1]),
 * array wildcards ([*]), quoted bracket keys (["a.b"]), and nested filters ([close == "user"]).
 */
function parsePathSegments(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const src = path.trim();
  const len = src.length;
  let i = 0;

  if (src[0] === '$') {
    i = 1;
    if (src[i] === '.') i++;
  } else if (src.startsWith('@.')) {
    i = 2;
  }

  while (i < len) {
    if (src[i] === '.') {
      i++;
      continue;
    }

    if (src[i] === '[') {
      const closeIdx = findMatchingDelimiter(src, i, '[', ']');
      if (closeIdx === -1) {
        throw new Error(`路径 "${path}" 缺少右方括号 "]"`);
      }
      const inner = src.slice(i + 1, closeIdx).trim();
      if (inner === '*' || inner === '') {
        segments.push({ kind: 'wildcard' });
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ kind: 'index', index: Number(inner) });
      } else if (
        (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
        (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
      ) {
        segments.push({ kind: 'prop', key: inner.slice(1, -1) });
      } else {
        segments.push({ kind: 'filter', predicate: inner });
      }
      i = closeIdx + 1;
      continue;
    }

    const start = i;
    while (i < len && src[i] !== '.' && src[i] !== '[') {
      i++;
    }
    const key = src.slice(start, i).trim();
    if (key === '*') {
      segments.push({ kind: 'wildcard' });
    } else if (key) {
      segments.push({ kind: 'prop', key });
    }
  }

  return segments;
}

/**
 * Resolve a path that may contain nested array indices ([1], [-1]),
 * wildcards ([*]), or nested filters ([key == "val"]).
 * Returns all matched values and whether the path fans out across multiple branches.
 */
export function resolvePathAll(obj: unknown, path: string): PathResolveAllResult {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '$' || trimmed === '@') {
    return { exists: true, values: [obj], isMulti: false };
  }

  const segments = parsePathSegments(trimmed);
  let currents: unknown[] = [obj];
  let isMulti = false;

  for (const seg of segments) {
    const next: unknown[] = [];

    if (seg.kind === 'wildcard') {
      isMulti = true;
      for (const cur of currents) {
        if (Array.isArray(cur)) {
          for (const el of cur) next.push(el);
        } else if (cur !== null && typeof cur === 'object') {
          for (const v of Object.values(cur as Record<string, unknown>)) next.push(v);
        }
      }
    } else if (seg.kind === 'filter') {
      isMulti = true;
      for (const cur of currents) {
        if (Array.isArray(cur)) {
          for (const el of cur) {
            if (evaluatePredicate(el, seg.predicate)) {
              next.push(el);
            }
          }
        }
      }
    } else if (seg.kind === 'index') {
      for (const cur of currents) {
        if (Array.isArray(cur)) {
          const resolvedIdx = seg.index < 0 ? cur.length + seg.index : seg.index;
          if (resolvedIdx >= 0 && resolvedIdx < cur.length) {
            next.push(cur[resolvedIdx]);
          }
        }
      }
    } else {
      for (const cur of currents) {
        if (cur === null || cur === undefined || typeof cur !== 'object') {
          continue;
        }
        if (Array.isArray(cur)) {
          const idx = Number(seg.key);
          if (Number.isInteger(idx) && idx >= 0 && idx < cur.length) {
            next.push(cur[idx]);
          }
          continue;
        }
        if (seg.key in (cur as Record<string, unknown>)) {
          next.push((cur as Record<string, unknown>)[seg.key]);
        }
      }
    }

    currents = next;
    if (currents.length === 0) {
      return { exists: false, values: [], isMulti };
    }
  }

  return { exists: true, values: currents, isMulti };
}

/**
 * Resolve a key path on an object (e.g. "specs.firmware.channel", "content[1].close", "content[*].close").
 * Returns { exists, value }. For wildcard/filter paths, value is the array of all matched values.
 */
export function resolvePath(
  obj: unknown,
  path: string
): { exists: boolean; value: unknown } {
  const res = resolvePathAll(obj, path);
  if (!res.exists) {
    return { exists: false, value: undefined };
  }
  return {
    exists: true,
    value: res.isMulti ? res.values : res.values[0],
  };
}

/**
 * Parse a user-supplied literal string ("123", "true", "null", "hello") into typed JS primitive for comparison.
 */
export function parseUserLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  return trimmed;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number(b) === a) {
    return true;
  }
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && Number(a) === b) {
    return true;
  }
  return false;
}

function valueContains(haystack: unknown, needle: unknown): boolean {
  if (haystack === null || haystack === undefined) return false;
  if (Array.isArray(haystack)) {
    return haystack.some((item) => valuesEqual(item, needle) || valueContains(item, needle));
  }
  if (typeof haystack === 'string') {
    return haystack.toLowerCase().includes(String(needle).toLowerCase());
  }
  if (typeof haystack === 'number' || typeof haystack === 'boolean') {
    return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
  }
  return false;
}

/**
 * Recursively check if ANY value inside `node` (primitive, nested object property, or array item)
 * matches `target` either by equality or substring containment.
 */
export function hasMatchingValueDeep(
  node: unknown,
  target: unknown,
  mode: 'equals' | 'contains',
  depth = 0
): boolean {
  if (depth > 16) return false;
  if (node === null || node === undefined || typeof node !== 'object') {
    return mode === 'equals' ? valuesEqual(node, target) : valueContains(node, target);
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      if (hasMatchingValueDeep(item, target, mode, depth + 1)) return true;
    }
    return false;
  }
  for (const val of Object.values(node as Record<string, unknown>)) {
    if (hasMatchingValueDeep(val, target, mode, depth + 1)) return true;
  }
  return false;
}

/**
 * Check if a key/path exists (including nested array indices like content[1].close or wildcards like content[*].close).
 */
function objectHasKey(item: unknown, keyPath: string): boolean {
  if (!keyPath.trim()) return false;
  return resolvePathAll(item, keyPath.trim()).exists;
}

function compareScalarValues(op: string, leftVal: unknown, rightVal: unknown): boolean {
  switch (op) {
    case '==':
      return valuesEqual(leftVal, rightVal);
    case '!=':
      return !valuesEqual(leftVal, rightVal);
    case '~=':
      return valueContains(leftVal, rightVal);
    case '>':
      return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal > rightVal;
    case '>=':
      return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal >= rightVal;
    case '<':
      return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal < rightVal;
    case '<=':
      return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal <= rightVal;
    default:
      return false;
  }
}

export function evaluateVisualCondition(item: unknown, cond: VisualCondition): boolean {
  const key = cond.key.trim();
  const typedVal = parseUserLiteral(cond.value);

  switch (cond.type) {
    case 'keyExists':
      return objectHasKey(item, key);
    case 'keyNotExists':
      return !objectHasKey(item, key);
    case 'keyEquals': {
      const res = resolvePathAll(item, key);
      return res.exists && res.values.some((v) => valuesEqual(v, typedVal));
    }
    case 'keyNotEquals': {
      const res = resolvePathAll(item, key);
      return res.exists && res.values.some((v) => !valuesEqual(v, typedVal));
    }
    case 'keyContains': {
      const res = resolvePathAll(item, key);
      return res.exists && res.values.some((v) => valueContains(v, typedVal));
    }
    case 'keyGt': {
      const res = resolvePathAll(item, key);
      return res.exists && res.values.some((v) => compareScalarValues('>', v, typedVal));
    }
    case 'keyGte': {
      const res = resolvePathAll(item, key);
      return res.exists && res.values.some((v) => compareScalarValues('>=', v, typedVal));
    }
    case 'keyLt': {
      const res = resolvePathAll(item, key);
      return res.exists && res.values.some((v) => compareScalarValues('<', v, typedVal));
    }
    case 'keyLte': {
      const res = resolvePathAll(item, key);
      return res.exists && res.values.some((v) => compareScalarValues('<=', v, typedVal));
    }
    case 'anyValueEquals':
      return hasMatchingValueDeep(item, typedVal, 'equals');
    case 'anyValueContains':
      return hasMatchingValueDeep(item, typedVal, 'contains');
    default:
      return true;
  }
}

/**
 * Discover all arrays in a parsed JSON value along with sample keys (including nested objects and nested array wildcard keys).
 */
export function discoverArrays(root: unknown): DiscoveredArray[] {
  const found: DiscoveredArray[] = [];

  const collectKeys = (obj: Record<string, unknown>, prefix: string, depth: number, keySet: Set<string>) => {
    for (const [k, v] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${k}` : k;
      keySet.add(fullKey);
      if (depth < 2 && v !== null && typeof v === 'object') {
        if (Array.isArray(v)) {
          for (const subEl of v.slice(0, 5)) {
            if (subEl !== null && typeof subEl === 'object' && !Array.isArray(subEl)) {
              collectKeys(subEl as Record<string, unknown>, `${fullKey}[*]`, depth + 1, keySet);
            }
          }
        } else {
          collectKeys(v as Record<string, unknown>, fullKey, depth + 1, keySet);
        }
      }
    }
  };

  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 8 || node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const keySet = new Set<string>();
      let objectCount = 0;
      for (const el of node) {
        if (el !== null && typeof el === 'object' && !Array.isArray(el)) {
          objectCount++;
          collectKeys(el as Record<string, unknown>, '', 0, keySet);
        }
      }
      found.push({
        path: path || '$',
        length: node.length,
        objectCount,
        sampleKeys: Array.from(keySet).slice(0, 40),
      });
      // Also inspect nested arrays inside first few objects
      node.slice(0, 5).forEach((el, idx) => {
        if (el !== null && typeof el === 'object') {
          walk(el, path ? `${path}[${idx}]` : `[${idx}]`, depth + 1);
        }
      });
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };

  walk(root, '', 0);
  // Prioritize arrays containing objects first
  found.sort((a, b) => b.objectCount - a.objectCount || b.length - a.length);
  return found;
}

/**
 * Generate a readable DSL expression string from a VisualExtractConfig.
 */
export function visualConfigToExpression(config: VisualExtractConfig): string {
  const basePath = config.arrayPath.trim() || '$';
  const activeConds = config.conditions.filter((c) => {
    if (c.type === 'keyExists' || c.type === 'keyNotExists') return c.key.trim().length > 0;
    if (c.type === 'anyValueEquals' || c.type === 'anyValueContains') return c.value.trim().length > 0;
    return c.key.trim().length > 0 && c.value.trim().length > 0;
  });

  const formatLit = (raw: string): string => {
    const parsed = parseUserLiteral(raw);
    if (typeof parsed === 'string') {
      return JSON.stringify(parsed);
    }
    return String(parsed);
  };

  let filterStr = '[*]';
  if (activeConds.length > 0) {
    const parts = activeConds.map((c) => {
      const k = c.key.trim();
      switch (c.type) {
        case 'keyExists':
          return `has(${k})`;
        case 'keyNotExists':
          return `!has(${k})`;
        case 'keyEquals':
          return `${k} == ${formatLit(c.value)}`;
        case 'keyNotEquals':
          return `${k} != ${formatLit(c.value)}`;
        case 'keyContains':
          return `${k} ~= ${formatLit(c.value)}`;
        case 'keyGt':
          return `${k} > ${formatLit(c.value)}`;
        case 'keyGte':
          return `${k} >= ${formatLit(c.value)}`;
        case 'keyLt':
          return `${k} < ${formatLit(c.value)}`;
        case 'keyLte':
          return `${k} <= ${formatLit(c.value)}`;
        case 'anyValueEquals':
          return `hasValue(${formatLit(c.value)})`;
        case 'anyValueContains':
          return `valueContains(${formatLit(c.value)})`;
      }
    });
    const glue = config.logic === 'and' ? ' && ' : ' || ';
    filterStr = `[${parts.join(glue)}]`;
  }

  let projStr = '';
  if (config.projectionMode === 'singleKey' && config.singleKey.trim()) {
    projStr = `.${config.singleKey.trim()}`;
  } else if (config.projectionMode === 'multiKeys' && config.selectedKeys.length > 0) {
    projStr = `.{${config.selectedKeys.join(', ')}}`;
  }

  return `${basePath}${filterStr}${projStr}`;
}

/* ============================================================================
 * Safe Recursive-Descent Expression Parser & Evaluator (Zero eval/Function)
 *
 * Supported syntax:
 *   path[predicate].field
 *   path[predicate].{field1, alias: nested.field2}
 *   $[predicate]
 *   Predicates:
 *     has(key) / exists(key) / ?key / !has(key)
 *     key == val, key != val, key > val, key >= val, key < val, key <= val
 *     key ~= val / key contains val
 *     hasValue(val) / $value == val / @value == val
 *     valueContains(val) / $value ~= val
 *     Logical: &&, ||, !, (...)
 * ============================================================================ */

type ExprToken =
  | { type: 'ident'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'null'; value: null }
  | { type: 'op'; value: string }
  | { type: 'punct'; value: string };

function tokenizePredicate(input: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Two-character operators
    const two = input.slice(i, i + 2);
    if (
      two === '==' ||
      two === '!=' ||
      two === '>=' ||
      two === '<=' ||
      two === '&&' ||
      two === '||' ||
      two === '~='
    ) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }

    // Single-character operators/punctuation
    if (ch === '>' || ch === '<' || ch === '!' || ch === '=') {
      tokens.push({ type: 'op', value: ch === '=' ? '==' : ch });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',' || ch === '?') {
      tokens.push({ type: 'punct', value: ch });
      i++;
      continue;
    }

    // Quoted strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let buf = '';
      while (i < len) {
        if (input[i] === '\\' && i + 1 < len) {
          buf += input[i + 1];
          i += 2;
          continue;
        }
        if (input[i] === quote) {
          i++;
          break;
        }
        buf += input[i];
        i++;
      }
      tokens.push({ type: 'string', value: buf });
      continue;
    }

    // Numbers
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '-' && i + 1 < len && input[i + 1] >= '0' && input[i + 1] <= '9')
    ) {
      const start = i;
      if (ch === '-') i++;
      while (i < len && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) i++;
      tokens.push({ type: 'number', value: Number(input.slice(start, i)) });
      continue;
    }

    // Identifiers & nested paths (supports dot paths, [index], [*], ["key"], nested [filter])
    const start = i;
    while (i < len) {
      const c = input[i];
      if (c === '[') {
        const closeIdx = findMatchingDelimiter(input, i, '[', ']');
        if (closeIdx === -1) {
          throw new Error('条件路径缺少右方括号 "]"');
        }
        i = closeIdx + 1;
        continue;
      }
      if (/[\s()[\]{},=!<>~&|'"?]/u.test(c)) {
        break;
      }
      i++;
    }
    const word = input.slice(start, i);
    if (!word) {
      throw new Error(`无法识别的符号 "${ch}"`);
    }
    const lower = word.toLowerCase();
    if (lower === 'true') {
      tokens.push({ type: 'boolean', value: true });
    } else if (lower === 'false') {
      tokens.push({ type: 'boolean', value: false });
    } else if (lower === 'null') {
      tokens.push({ type: 'null', value: null });
    } else if (lower === 'and') {
      tokens.push({ type: 'op', value: '&&' });
    } else if (lower === 'or') {
      tokens.push({ type: 'op', value: '||' });
    } else if (lower === 'not') {
      tokens.push({ type: 'op', value: '!' });
    } else if (lower === 'contains') {
      tokens.push({ type: 'op', value: '~=' });
    } else {
      tokens.push({ type: 'ident', value: word });
    }
  }

  return tokens;
}

function evaluatePredicate(item: unknown, predicateSrc: string): boolean {
  const trimmed = predicateSrc.trim();
  if (!trimmed || trimmed === '*') return true;

  const tokens = tokenizePredicate(trimmed);
  if (tokens.length === 0) return true;

  let pos = 0;

  // Allow optional leading '?' (JSONPath style: [?key == "val"])
  if (tokens[0]?.type === 'punct' && tokens[0].value === '?') {
    pos++;
  }

  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  const readLiteralOrPath = (): {
    isValueWildcard: boolean;
    path?: string;
    resolved: PathResolveAllResult;
  } => {
    const tok = consume();
    if (!tok) throw new Error('条件表达式缺少操作数');
    if (tok.type === 'string' || tok.type === 'number' || tok.type === 'boolean' || tok.type === 'null') {
      return {
        isValueWildcard: false,
        resolved: { exists: true, values: [tok.value], isMulti: false },
      };
    }
    if (tok.type === 'ident') {
      if (tok.value === '$value' || tok.value === '@value' || tok.value === 'anyValue') {
        return {
          isValueWildcard: true,
          resolved: { exists: true, values: [], isMulti: true },
        };
      }
      const cleanPath = tok.value.startsWith('@.') ? tok.value.slice(2) : tok.value;
      return {
        isValueWildcard: false,
        path: cleanPath,
        resolved: resolvePathAll(item, cleanPath),
      };
    }
    throw new Error(`意外的符号 "${tok.value}"`);
  };

  const parseOr = (): boolean => {
    let left = parseAnd();
    while (peek()?.type === 'op' && peek()!.value === '||') {
      consume();
      const right = parseAnd();
      left = left || right;
    }
    return left;
  };

  const parseAnd = (): boolean => {
    let left = parseUnary();
    while (peek()?.type === 'op' && peek()!.value === '&&') {
      consume();
      const right = parseUnary();
      left = left && right;
    }
    return left;
  };

  const parseUnary = (): boolean => {
    if (peek()?.type === 'op' && peek()!.value === '!') {
      consume();
      return !parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): boolean => {
    const tok = peek();
    if (!tok) throw new Error('条件表达式不完整');

    // Grouped sub-expression
    if (tok.type === 'punct' && tok.value === '(') {
      consume();
      const val = parseOr();
      const close = consume();
      if (!close || close.type !== 'punct' || close.value !== ')') {
        throw new Error('条件表达式缺少右括号 ")"');
      }
      return val;
    }

    // Function calls: has(key), exists(key), hasValue(val), valueContains(val)
    if (
      tok.type === 'ident' &&
      tokens[pos + 1]?.type === 'punct' &&
      tokens[pos + 1].value === '('
    ) {
      consume(); // fnName
      const fnName = tok.value.toLowerCase();
      consume(); // '('
      const argTok = consume();
      if (!argTok) throw new Error(`函数 ${fnName}() 缺少参数`);
      const close = consume();
      if (!close || close.type !== 'punct' || close.value !== ')') {
        throw new Error(`函数 ${fnName}() 缺少右括号 ")"`);
      }

      if (fnName === 'has' || fnName === 'exists' || fnName === 'haskey') {
        const keyName = String(argTok.value);
        return objectHasKey(item, keyName);
      }
      if (fnName === 'hasvalue' || fnName === 'valueequals' || fnName === 'anyvalue') {
        const target = argTok.type === 'ident' ? parseUserLiteral(argTok.value) : argTok.value;
        return hasMatchingValueDeep(item, target, 'equals');
      }
      if (fnName === 'valuecontains' || fnName === 'containsvalue') {
        const target = argTok.type === 'ident' ? parseUserLiteral(argTok.value) : argTok.value;
        return hasMatchingValueDeep(item, target, 'contains');
      }
      throw new Error(`不支持的函数 "${fnName}"，可用函数：has()、exists()、hasValue()、valueContains()`);
    }

    // Comparison or bare key existence check
    const left = readLiteralOrPath();
    const nextTok = peek();

    if (
      nextTok?.type === 'op' &&
      (nextTok.value === '==' ||
        nextTok.value === '!=' ||
        nextTok.value === '>' ||
        nextTok.value === '>=' ||
        nextTok.value === '<' ||
        nextTok.value === '<=' ||
        nextTok.value === '~=')
    ) {
      consume();
      const op = nextTok.value;
      const right = readLiteralOrPath();

      if (left.isValueWildcard) {
        if (!right.resolved.exists || right.resolved.values.length === 0) return false;
        if (op === '==') {
          return right.resolved.values.some((rv) => hasMatchingValueDeep(item, rv, 'equals'));
        }
        if (op === '!=') {
          return right.resolved.values.every((rv) => !hasMatchingValueDeep(item, rv, 'equals'));
        }
        if (op === '~=') {
          return right.resolved.values.some((rv) => hasMatchingValueDeep(item, rv, 'contains'));
        }
        throw new Error(`$value 仅支持 ==、!= 或 ~= 运算符`);
      }

      if (!left.resolved.exists || left.resolved.values.length === 0) {
        return !left.resolved.isMulti && op === '!=' ? true : false;
      }

      if (!right.resolved.exists || right.resolved.values.length === 0) {
        return !right.resolved.isMulti && op === '!=' ? true : false;
      }

      // Supports both single-value paths (content[1].close == "user")
      // and wildcard/filter paths (content[*].close == "user" -> true if ANY element matches)
      return left.resolved.values.some((lv) =>
        right.resolved.values.some((rv) => compareScalarValues(op, lv, rv))
      );
    }

    // Bare key/path check: e.g. [?specs.firmware], [content[1].close], [content[*].close]
    if (left.path !== undefined) {
      return left.resolved.exists && left.resolved.values.some((v) => v !== undefined);
    }
    return left.resolved.values.some((v) => Boolean(v));
  };

  const result = parseOr();
  if (pos < tokens.length) {
    throw new Error(`条件表达式存在多余内容 "${tokens[pos].value}"`);
  }
  return result;
}

function splitTopLevelCommas(src: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      const part = src.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const last = src.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function findTopLevelColon(src: string): number {
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

function projectSingleItem(item: unknown, projectionPart: string): unknown {
  const proj = projectionPart.trim();
  if (!proj || proj === '*') return item;

  // Multi-key projection: { sku, title, secondClose: content[1].close, allCloses: content[*].close }
  if (proj.startsWith('{') && proj.endsWith('}')) {
    const inner = proj.slice(1, -1).trim();
    if (!inner) return {};
    const fields = splitTopLevelCommas(inner);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const colonIdx = findTopLevelColon(f);
      if (colonIdx !== -1) {
        const alias = f.slice(0, colonIdx).trim();
        const path = f.slice(colonIdx + 1).trim();
        const res = resolvePath(item, path);
        out[alias] = res.exists ? res.value : null;
      } else {
        const res = resolvePath(item, f);
        const keyLabel = f.includes('.') ? f.split('.').pop()! : f;
        out[keyLabel] = res.exists ? res.value : null;
      }
    }
    return out;
  }

  // Single key / nested path projection
  const res = resolvePath(item, proj);
  return res.exists ? res.value : undefined;
}

function deduplicateResults(arr: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of arr) {
    const sig = JSON.stringify(item);
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(item);
    }
  }
  return out;
}

/**
 * Execute a data extraction expression against parsed JSON data.
 * Examples:
 *   items[unitPrice >= 500].{sku, title, unitPrice}
 *   items[has(specs.firmware)].sku
 *   items[hasValue("RS485")]
 *   timeline[step == "paid"].at
 */
export function runExtractExpression(
  rootData: unknown,
  expression: string,
  options?: { deduplicate?: boolean }
): ExtractResult {
  const expr = expression.trim();
  if (!expr) {
    return { ok: false, error: '请输入提取表达式' };
  }

  try {
    let cursor = 0;
    const len = expr.length;
    let current: unknown = rootData;
    let isArrayStream = Array.isArray(rootData);
    let justMappedProperty = false;
    let sourceCount: number | undefined = Array.isArray(rootData) ? rootData.length : undefined;
    let matchedCount: number | undefined;

    // Strip optional leading '$'
    if (expr[cursor] === '$') {
      cursor++;
      if (expr[cursor] === '.') cursor++;
    }

    while (cursor < len) {
      while (cursor < len && (expr[cursor] === ' ' || expr[cursor] === '\t')) cursor++;
      if (cursor >= len) break;

      const ch = expr[cursor];

      // Skip leading dot separator
      if (ch === '.') {
        cursor++;
        continue;
      }

      // Multi-key object projection: .{a, b, c: d.e}
      if (ch === '{') {
        const closeIdx = findMatchingDelimiter(expr, cursor, '{', '}');
        if (closeIdx === -1) {
          return { ok: false, error: '提取字段块缺少右花括号 "}"' };
        }
        const block = expr.slice(cursor, closeIdx + 1);
        if (isArrayStream && Array.isArray(current)) {
          current = current.map((el) => projectSingleItem(el, block));
        } else {
          current = projectSingleItem(current, block);
        }
        justMappedProperty = false;
        cursor = closeIdx + 1;
        continue;
      }

      // Bracket filter or index: [predicate] or [0] or [*]
      if (ch === '[') {
        const closeIdx = findMatchingDelimiter(expr, cursor, '[', ']');
        if (closeIdx === -1) {
          return { ok: false, error: '筛选条件缺少右方括号 "]"' };
        }
        const inner = expr.slice(cursor + 1, closeIdx).trim();

        if (!Array.isArray(current)) {
          return { ok: false, error: '当前路径指向的不是数组，无法应用 [...] 筛选条件' };
        }

        // If we just mapped an array-valued property across an array stream (e.g. messages[...].content[1] or .content[*].text),
        // apply inner-array indexing / wildcard flattening / nested filtering per item!
        const isMappedArrayOfArrays =
          justMappedProperty && current.length > 0 && current.every((el) => Array.isArray(el));

        if (isMappedArrayOfArrays) {
          if (/^-?\d+$/.test(inner)) {
            const idx = Number(inner);
            const picked: unknown[] = [];
            for (const subArr of current as unknown[][]) {
              const resolvedIdx = idx < 0 ? subArr.length + idx : idx;
              if (resolvedIdx >= 0 && resolvedIdx < subArr.length) {
                picked.push(subArr[resolvedIdx]);
              }
            }
            current = picked;
            isArrayStream = true;
            matchedCount = picked.length;
          } else if (inner === '*' || inner === '') {
            const flattened = (current as unknown[][]).flat();
            current = flattened;
            isArrayStream = true;
            justMappedProperty = false;
            matchedCount = flattened.length;
          } else {
            const flattenedFiltered = (current as unknown[][])
              .flat()
              .filter((el) => evaluatePredicate(el, inner));
            current = flattenedFiltered;
            isArrayStream = true;
            justMappedProperty = false;
            matchedCount = flattenedFiltered.length;
          }
          cursor = closeIdx + 1;
          continue;
        }

        sourceCount = current.length;

        // Numeric index access [0], [1], [-1]
        if (/^-?\d+$/.test(inner)) {
          const idx = Number(inner);
          const resolvedIdx = idx < 0 ? current.length + idx : idx;
          current = current[resolvedIdx];
          isArrayStream = Array.isArray(current);
          matchedCount = current !== undefined ? 1 : 0;
        } else {
          const filtered = current.filter((el) => evaluatePredicate(el, inner));
          current = filtered;
          isArrayStream = true;
          matchedCount = filtered.length;
        }

        justMappedProperty = false;
        cursor = closeIdx + 1;
        continue;
      }

      // Identifier segment (property name)
      const start = cursor;
      while (cursor < len && expr[cursor] !== '.' && expr[cursor] !== '[' && expr[cursor] !== '{') {
        cursor++;
      }
      const prop = expr.slice(start, cursor).trim();
      if (!prop || prop === '*') continue;

      if (isArrayStream && Array.isArray(current)) {
        const mapped: unknown[] = [];
        for (const el of current) {
          const r = resolvePath(el, prop);
          if (r.exists) mapped.push(r.value);
        }
        current = mapped;
        justMappedProperty = true;
      } else {
        const r = resolvePath(current, prop);
        if (!r.exists) {
          return { ok: false, error: `路径 "${prop}" 在当前数据中不存在` };
        }
        current = r.value;
        isArrayStream = Array.isArray(current);
        justMappedProperty = false;
        if (Array.isArray(current)) {
          sourceCount = current.length;
        }
      }
    }

    if (options?.deduplicate && Array.isArray(current)) {
      current = deduplicateResults(current);
    }

    if (matchedCount === undefined && Array.isArray(current)) {
      matchedCount = current.length;
    }

    return {
      ok: true,
      data: current,
      matchedCount,
      sourceCount,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : '表达式解析失败',
    };
  }
}

/**
 * Build smart example expressions tailored to the actual arrays & keys in the current JSON document.
 */
export function buildSuggestedExpressions(arrays: DiscoveredArray[]): Array<{ label: string; expr: string }> {
  const suggestions: Array<{ label: string; expr: string }> = [];
  const primary = arrays.find((a) => a.objectCount > 0);
  if (!primary) return suggestions;

  const p = primary.path;
  const keys = primary.sampleKeys;
  const firstKey = keys[0];
  const secondKey = keys[1];
  const nestedKey = keys.find((k) => k.includes('.'));

  if (nestedKey) {
    suggestions.push({
      label: `存在键 ${nestedKey}`,
      expr: `${p}[has(${nestedKey})]${firstKey && secondKey ? `.{${firstKey}, ${secondKey}}` : ''}`,
    });
  } else if (firstKey) {
    suggestions.push({
      label: `存在键 ${firstKey}`,
      expr: `${p}[has(${firstKey})]`,
    });
  }

  if (firstKey && secondKey) {
    suggestions.push({
      label: `提取多个指定键`,
      expr: `${p}[*].{${firstKey}, ${secondKey}}`,
    });
  }

  if (firstKey) {
    suggestions.push({
      label: `仅提取 ${firstKey} 值列表`,
      expr: `${p}[*].${firstKey}`,
    });
  }

  suggestions.push({
    label: `按任意 Value 匹配`,
    expr: `${p}[hasValue("RS485")]`,
  });

  return suggestions.slice(0, 4);
}
