import { fromMarkdown } from "mdast-util-from-markdown";

export const CITATION_PREFIX = ":codex-file-citation{";
export const VISUALIZATION_PREFIX = "\uE200visualize\uE202";
const VISUALIZATION_END = "\uE201";
const MAX_DIRECTIVE_LENGTH = 4096;

export type CitationSegment =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; artifactKind?: string }
  | { kind: "pending" }
  | { kind: "invalid" };

interface SourceNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SourceNode[];
}

function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (node: SourceNode) => {
    if (["code", "inlineCode", "link", "image", "definition", "html"].includes(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(text));
  return ranges;
}

function attributes(source: string): Record<string, string> | null {
  const values: Record<string, string> = {};
  let remaining = source;
  while (remaining.trim()) {
    const match = /^\s*([a-z][a-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/i.exec(
      remaining,
    );
    if (!match || Object.hasOwn(values, match[1])) return null;
    const quoted = match[2];
    // Decode quoted delimiters, retaining literal backslashes in Windows paths.
    values[match[1]] = quoted.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    remaining = remaining.slice(match[0].length);
    if (remaining && !/^\s/.test(remaining)) return null;
  }
  return values;
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function directiveEnd(text: string, start: number, prefix: string, terminator: string): number {
  let quote: string | null = null;
  let end = start + prefix.length;
  for (; end < text.length && end - start <= MAX_DIRECTIVE_LENGTH; end++) {
    const char = text[end];
    if ((char === "\n" || char === "\r") && (quote || /^\r?\n\s*\r?\n/.test(text.slice(end))))
      break;
    if (char === "\\" && quote && /["'\\]/.test(text[end + 1] ?? "")) {
      end++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === terminator) break;
  }
  return end;
}

function fileSegment(source: string): CitationSegment {
  const attrs = attributes(source);
  if (
    !attrs?.path ||
    hasControlCharacters(attrs.path) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(attrs.path)
  )
    return { kind: "invalid" };
  return {
    kind: "file",
    path: attrs.path,
    ...(attrs.artifact_kind ? { artifactKind: attrs.artifact_kind } : {}),
  };
}

function visualizationSegment(source: string): CitationSegment {
  try {
    const data: unknown = JSON.parse(source);
    if (!data || typeof data !== "object" || Array.isArray(data) || !("path" in data))
      return { kind: "invalid" };
    const path = data.path;
    if (
      typeof path !== "string" ||
      !path.trim() ||
      hasControlCharacters(path) ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ||
      !/\.html?$/i.test(path)
    )
      return { kind: "invalid" };
    // Layout hints such as `mode: wide` belong to the originating chat surface.
    // Paseo opens the HTML in its existing full-size, sandboxed file panel.
    return { kind: "file", path, artifactKind: "html" };
  } catch {
    return { kind: "invalid" };
  }
}

const DIRECTIVES = [
  { prefix: CITATION_PREFIX, terminator: "}", parse: fileSegment },
  { prefix: VISUALIZATION_PREFIX, terminator: VISUALIZATION_END, parse: visualizationSegment },
];

function nextDirective(text: string, from: number) {
  return DIRECTIVES.map((directive) => ({
    ...directive,
    start: text.indexOf(directive.prefix, from),
  }))
    .filter(({ start }) => start >= 0)
    .sort((a, b) => a.start - b.start)[0];
}

/** Parse presentation directives only. Code examples and authored links stay literal. */
export function splitFileCitations(text: string, streaming = false): CitationSegment[] {
  if (!DIRECTIVES.some(({ prefix }) => text.includes(prefix))) return [{ kind: "text", text }];
  const ranges = protectedRanges(text);
  const segments: CitationSegment[] = [];
  let copied = 0;
  let search = 0;
  while (search < text.length) {
    const directive = nextDirective(text, search);
    if (!directive) break;
    const { start, prefix, terminator, parse } = directive;
    search = start + prefix.length;
    if (text[start - 1] === "\\" || ranges.some(([a, b]) => start >= a && start < b)) continue;
    const end = directiveEnd(text, start, prefix, terminator);
    if (start > copied) segments.push({ kind: "text", text: text.slice(copied, start) });
    if (text[end] !== terminator) {
      // A bounded incomplete token must never consume the following paragraphs.
      segments.push({ kind: streaming && end === text.length ? "pending" : "invalid" });
      copied = Math.min(end, text.length);
      search = copied;
      continue;
    }
    const source = text.slice(start + prefix.length, end);
    segments.push(parse(source));
    copied = end + 1;
    search = copied;
  }
  if (copied < text.length) segments.push({ kind: "text", text: text.slice(copied) });
  return segments.length ? segments : [{ kind: "text", text }];
}

export function hasFileCitations(text: string): boolean {
  return splitFileCitations(text).some((segment) => segment.kind !== "text");
}

export function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export function fileLabel(path: string): string {
  const extension = fileName(path).split(".").pop()?.toLowerCase();
  const labels: Record<string, string> = {
    xlsx: "Excel",
    xls: "Excel",
    csv: "CSV",
    tsv: "TSV",
    docx: "Word",
    pdf: "PDF",
    pptx: "PowerPoint",
    md: "Markdown",
    png: "图片",
    jpg: "图片",
    jpeg: "图片",
    webp: "图片",
  };
  return (extension && labels[extension]) || "文件";
}

/** Filename links go through the same file opener as authored Markdown links. */
export function fileLink(path: string): string {
  const name = fileName(path).replace(/[\\`*_[\]<>]/g, "\\$&");
  const href = path
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/^([A-Za-z])%3A$/, "$1:"))
    .join("/");
  return `[${name}](<${href}>)`;
}

export function citationMarkdown(segment: CitationSegment): string {
  if (segment.kind === "text") return segment.text;
  if (segment.kind === "file") return fileLink(segment.path);
  return segment.kind === "pending" ? "文件信息生成中…" : "文件引用格式不完整。";
}

export function citationsToLinks(text: string, streaming = false): string {
  return splitFileCitations(text, streaming).map(citationMarkdown).join("");
}
