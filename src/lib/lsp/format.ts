import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Location,
  LocationLink,
  Hover,
  Diagnostic,
  DocumentSymbol,
  SymbolInformation,
  Range,
} from 'vscode-languageserver-protocol';

/** LSP positions are 0-based; humans want 1-based. */
function pos(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}

function relUri(uri: string, root: string): string {
  try {
    const abs = fileURLToPath(uri);
    const rel = path.relative(root, abs);
    return rel.startsWith('..') ? abs : rel;
  } catch {
    return uri;
  }
}

type LocLike = Location | LocationLink;

function locUri(l: LocLike): string {
  return 'uri' in l ? l.uri : l.targetUri;
}
function locRange(l: LocLike): Range {
  return 'range' in l ? l.range : l.targetSelectionRange;
}

function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function formatLocations(result: unknown, root: string, verb = 'Defined'): string {
  const locs = toArray(result as LocLike | LocLike[]);
  if (locs.length === 0) return `No ${verb.toLowerCase()} location found.`;
  return locs
    .map((l) => `${verb} in ${relUri(locUri(l), root)}:${pos(locRange(l).start.line, locRange(l).start.character)}`)
    .join('\n');
}

export function formatReferences(result: unknown, root: string): string {
  const locs = toArray(result as Location | Location[]);
  if (locs.length === 0) return 'No references found.';
  const byFile = new Map<string, string[]>();
  for (const l of locs) {
    const file = relUri(l.uri, root);
    const arr = byFile.get(file) ?? [];
    arr.push(pos(l.range.start.line, l.range.start.character));
    byFile.set(file, arr);
  }
  const lines: string[] = [`Found ${locs.length} reference${locs.length === 1 ? '' : 's'} across ${byFile.size} file${byFile.size === 1 ? '' : 's'}:`];
  for (const [file, positions] of byFile) {
    lines.push(`${file}:`);
    for (const p of positions) lines.push(`  ${p}`);
  }
  return lines.join('\n');
}

export function formatHover(result: unknown): string {
  const hover = result as Hover | null;
  if (!hover || !hover.contents) return 'No hover information.';
  const c = hover.contents;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((part) => (typeof part === 'string' ? part : part.value)).join('\n');
  }
  return (c as { value: string }).value;
}

const SYMBOL_KINDS = [
  '', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property',
  'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember',
  'Struct', 'Event', 'Operator', 'TypeParameter',
];
function kindName(kind: number): string {
  return SYMBOL_KINDS[kind] ?? 'Symbol';
}

export function formatDocumentSymbols(result: unknown): string {
  const symbols = (Array.isArray(result) ? result : []) as (DocumentSymbol | SymbolInformation)[];
  if (symbols.length === 0) return 'No symbols found.';
  const lines: string[] = [];
  // DocumentSymbol has `range`/`children`; SymbolInformation has `location`.
  const isHierarchical = 'range' in symbols[0] && !('location' in symbols[0]);
  if (isHierarchical) {
    const walk = (syms: DocumentSymbol[], depth: number) => {
      for (const s of syms) {
        lines.push(`${'  '.repeat(depth)}${kindName(s.kind)}: ${s.name} (line ${s.range.start.line + 1})`);
        if (s.children?.length) walk(s.children, depth + 1);
      }
    };
    walk(symbols as DocumentSymbol[], 0);
  } else {
    for (const s of symbols as SymbolInformation[]) {
      lines.push(`${kindName(s.kind)}: ${s.name} (line ${s.location.range.start.line + 1})`);
    }
  }
  return `Found ${lines.length} symbol${lines.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

export function formatWorkspaceSymbols(result: unknown, root: string): string {
  const symbols = toArray(result as SymbolInformation[]);
  if (symbols.length === 0) return 'No symbols found.';
  return symbols
    .map((s) => `${kindName(s.kind)} ${s.name} — ${relUri(s.location.uri, root)}:${s.location.range.start.line + 1}`)
    .join('\n');
}

const SEVERITY = ['', 'Error', 'Warning', 'Info', 'Hint'];

export function formatDiagnostics(diags: Diagnostic[], relPath: string): string {
  if (diags.length === 0) return 'No diagnostics.';
  return diags
    .map((d) => {
      const sev = SEVERITY[d.severity ?? 1] ?? 'Error';
      const code = d.code !== undefined ? ` [${d.code}]` : '';
      return `${relPath}:${pos(d.range.start.line, d.range.start.character)} ${sev}${code}: ${d.message}`;
    })
    .join('\n');
}
