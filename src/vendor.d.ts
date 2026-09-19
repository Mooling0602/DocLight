/*
 * `turndown-plugin-gfm` ships no type declarations and has no @types package. It exports a
 * set of Turndown plugins; only `gfm` (tables, strikethrough, task list items, ...) is used
 * here. Declaring just the shape we consume keeps the build typed without vendoring the
 * whole plugin API.
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  type TurndownPlugin = (service: TurndownService) => void;

  export const gfm: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
}
