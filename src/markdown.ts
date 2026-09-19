/*
 * Markdown <-> HTML conversion, shared by the server migration and the browser editor.
 *
 * The server stores page content as Markdown (database v4). Legacy v3 databases held
 * HTML, so the first read after upgrading converts every page once with `htmlToMarkdown`.
 * The browser reverses the direction to render the reading view and to load the visual
 * editor, then converts back on save.
 *
 * Formats Markdown cannot express (underline, alignment, colour) are intentionally kept
 * as raw inline HTML so the conversion is lossless — `marked` passes raw HTML through and
 * the client sanitises the result with DOMPurify before it reaches the DOM.
 */
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/** Turndown options shared by every conversion site, so migration and editing stay identical. */
const TURNDOWN_OPTIONS = {
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  bulletListMarker: '-',
  hr: '---',
} as const;

function createTurndown(): TurndownService {
  const td = new TurndownService(TURNDOWN_OPTIONS);
  // GFM covers tables and task list items. It is registered before the hand-written rules so
  // those still win where they overlap: the plugin treats `<s>` as strikethrough too, and the
  // explicit rule below keeps the delimiter stable across round-trips.
  td.use(gfm);
  // Underline has no Markdown syntax: keep the tag so the round-trip is lossless.
  td.addRule('underline', {
    filter: ['u'],
    replacement: (content) => `<u>${content}</u>`,
  });
  // Strikethrough is GFM `~~text~~`; `<del>` comes from `marked` rendering `~~…~~`.
  td.addRule('strikethrough', {
    filter: (node) => node.nodeType === 1 && /^(S|STRIKE|DEL)$/.test(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  });
  // Any element carrying an inline style (alignment, colour, ...) is preserved verbatim:
  // Markdown has no representation for it and dropping it would lose the author's intent.
  td.addRule('keep-styled', {
    filter: (node) => node.nodeType === 1
      && node.nodeName !== 'CODE'
      && !!(node.getAttribute && node.getAttribute('style')),
    replacement: (_content, node) => (node as unknown as { outerHTML: string }).outerHTML,
  });
  return td;
}

/**
 * Turndown pads list markers for alignment (`-   item`, `1.  item`). Collapse that padding
 * to a single space so stored Markdown reads naturally; the leading indentation that marks
 * nesting depth is preserved. Lines inside a fenced code block are left byte-for-byte alone,
 * otherwise a code line like `- foo` would be reformatted.
 */
function tidyListMarkers(markdown: string): string {
  let inFence = false;
  return markdown.split('\n').map((line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line
      .replace(/^(\s*)([-*+]|\d+\.)\s{1,}/, '$1$2 ')
      // The GFM task-list rule emits `- [x]  text`; collapse that extra space too.
      .replace(/^(\s*[-*+] \[[ xX]\])\s{1,}/, '$1 ');
  }).join('\n');
}

/** Convert author HTML (editor output or legacy content) into Markdown. */
export function htmlToMarkdown(html: unknown): string {
  const source = String(html ?? '');
  if (!source.trim()) return '';
  try {
    return tidyListMarkers(createTurndown().turndown(source).trim());
  } catch {
    // A malformed fragment must never take down a save or a migration; fall back to the input.
    return source;
  }
}

/**
 * Cap stored Markdown length (matches the 1MB request limit, with room for the rest of the
 * record). Markdown is opaque text at rest — XSS is handled when rendering, not here, so a
 * regex tag scrubber would only corrupt code blocks containing HTML examples.
 */
export function sanitizeMarkdown(text: unknown): string {
  return String(text ?? '').replace(/\r\n/g, '\n').slice(0, 500 * 1024);
}
