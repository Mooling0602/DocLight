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
import { Lexer, Marked, Tokenizer, type MarkedExtension, type Token, type Tokens } from 'marked';
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

/* ---------------------------------------------------------------- GitHub callouts
 * GitHub's alert syntax is not a Markdown construct of its own: `[!NOTE]` is simply the
 * first line of a blockquote. Recognising it as a dedicated block token lets the reader
 * view render a coloured card, while the turndown rules at the bottom turn the card back
 * into the original blockquote, so opening and saving a page never rewrites the source.
 */

export const CALLOUT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

interface CalloutToken extends Tokens.Generic {
  type: 'callout';
  raw: string;
  text: string;
  calloutType: CalloutType;
  tokens: Token[];
}

/** The marker may only be followed by whitespace: `> [!NOTE] 补充` stays a plain quote. */
const CALLOUT_START = /^ {0,3}>[ \t]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

/** Titles follow the UI language, as GitHub does: the content language is the author's. */
const CALLOUT_LABELS: Record<CalloutType, string> = {
  note: '注意',
  tip: '提示',
  important: '重要',
  warning: '警告',
  caution: '危险',
};

const CALLOUT_ICON_PATHS: Record<CalloutType, string> = {
  note: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  tip: 'M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z',
  important: 'M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  warning: 'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  caution: 'M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
};

function iconSvg(type: CalloutType): string {
  return '<svg class="callout-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">'
    + `<path d="${CALLOUT_ICON_PATHS[type]}"/></svg>`;
}

function renderCallout(type: CalloutType, body: string): string {
  return `<div class="callout callout-${type}">`
    + `<div class="callout-title">${iconSvg(type)}<span>${CALLOUT_LABELS[type]}</span></div>`
    + `${body}</div>\n`;
}

const callout: MarkedExtension = {
  extensions: [
    {
      name: 'callout',
      level: 'block',
      start(src) {
        const match = CALLOUT_START.exec(src);
        return match ? match.index : undefined;
      },
      tokenizer(src) {
        const head = CALLOUT_START.exec(src);
        if (!head) return undefined;
        // Use Marked's blockquote rules for lazy continuation and block boundaries rather than
        // consuming only `>`-prefixed lines. A separate lexer prevents recursive callout parsing.
        const tokenizer = new Tokenizer({ gfm: true });
        new Lexer({ gfm: true, tokenizer });
        const quote = tokenizer.blockquote(src);
        if (!quote) return undefined;
        const raw = quote.raw;
        const text = quote.text.replace(/^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i, '');
        return {
          type: 'callout',
          raw,
          text,
          calloutType: head[1].toLowerCase() as CalloutType,
          tokens: this.lexer.blockTokens(text, []),
        };
      },
      renderer(token) {
        const typed = token as unknown as CalloutToken;
        return renderCallout(typed.calloutType, this.parser.parse(typed.tokens));
      },
    },
  ],
};

const markdownParser = new Marked(callout);
markdownParser.setOptions({ gfm: true });

/**
 * Render stored Markdown to HTML. Output is not sanitised here — the browser runs it through
 * DOMPurify before inserting it into the DOM, and raw HTML in the source passes through.
 */
export function markdownToHtml(markdown: unknown): string {
  const source = String(markdown ?? '');
  if (!source.trim()) return '';
  return markdownParser.parse(source, { async: false }) as string;
}

/* ---------------------------------------------------------------- HTML -> Markdown */

/** Structural view of a DOM node, so this file needs no DOM lib on the server build. */
interface DomNodeLike {
  nodeType: number;
  nodeName?: string;
  classList?: { contains(name: string): boolean };
}

function hasClass(node: unknown, name: string): boolean {
  const el = node as DomNodeLike | null;
  return !!el && el.nodeType === 1 && !!el.classList?.contains(name);
}

function calloutTypeOf(node: unknown): CalloutType | null {
  for (const type of CALLOUT_TYPES) {
    if (hasClass(node, `callout-${type}`)) return type;
  }
  return null;
}

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
  // A callout card is a blockquote with a marker line, so the title (icon + label) is
  // generated decoration and must not leak back into the stored Markdown.
  td.addRule('callout-title', {
    filter: (node) => hasClass(node, 'callout-title'),
    replacement: () => '',
  });
  td.addRule('callout', {
    filter: (node) => hasClass(node, 'callout') && (node.nodeName === 'DIV'),
    replacement: (content, node) => {
      const type = calloutTypeOf(node);
      if (!type) return content;
      const marker = `> [!${type.toUpperCase()}]`;
      const body = content.trim();
      if (!body) return `${marker}\n\n`;
      const quoted = body.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
      return `${marker}\n${quoted}\n\n`;
    },
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
 * otherwise a code line like `- foo` would be reformatted. Blockquote prefixes (a callout
 * holds a list at `>` depth) are kept in front: the padding is inside the quoted content.
 */
function tidyListMarkers(markdown: string): string {
  let inFence = false;
  return markdown.split('\n').map((line) => {
    const quoted = /^((?: {0,3}> ?)+)/.exec(line);
    const prefix = quoted ? quoted[1] : '';
    const body = line.slice(prefix.length);
    if (/^\s{0,3}(```|~~~)/.test(body)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return prefix + body
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
