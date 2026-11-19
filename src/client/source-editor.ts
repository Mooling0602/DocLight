/* Markdown source editor; the document is the page body, never its storage front matter. */
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '700' },
  { tag: [tags.strong], fontWeight: '700' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--callout-note)' },
  { tag: tags.monospace, color: 'var(--callout-tip)' },
  { tag: [tags.quote, tags.list, tags.contentSeparator, tags.meta], color: 'var(--text-2)' },
]);

/** The caller owns the view lifecycle and carries the body across editor modes. */
export function createMarkdownEditor(parent: HTMLElement, text: string, wrap: boolean, onChange: () => void) {
  const wrapping = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(),
        history(), keymap.of([indentWithTab]), indentUnit.of('  '),
        markdown({ base: markdownLanguage }), keymap.of([...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(markdownHighlight),
        wrapping.of(wrap ? EditorView.lineWrapping : []),
        placeholder('# 标题\n\n用 Markdown 写下正文……'),
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码编辑区', spellcheck: 'false' }),
        EditorView.updateListener.of(update => { if (update.docChanged) onChange(); }),
      ],
    }),
  });
  return {
    view,
    setWrap(enabled: boolean) { view.dispatch({ effects: wrapping.reconfigure(enabled ? EditorView.lineWrapping : []) }); },
    destroy() { view.destroy(); },
  };
}
