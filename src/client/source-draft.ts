import type { Text } from '@codemirror/state';

/** Retain the last immutable editor document even if its view is later destroyed. */
export class SourceDraft {
  private document: Text | null = null;

  update(document: Text): void { this.document = document; }
  clear(): void { this.document = null; }
  read(fallback: string): string { return this.document ? this.document.toString() : fallback; }
}
