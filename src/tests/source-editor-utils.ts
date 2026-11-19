import assert from 'node:assert/strict';
import { EditorView } from '@codemirror/view';

/** Access the mounted editor through CodeMirror's public DOM lookup. */
export function sourceView(document: Document): EditorView {
  const root = document.querySelector<HTMLElement>('#source-editor');
  assert.ok(root, 'Markdown 编辑器容器应存在');
  const view = EditorView.findFromDOM(root);
  assert.ok(view, 'Markdown 编辑器应已挂载');
  return view;
}

export function setSource(document: Document, text: string): void {
  const view = sourceView(document);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
