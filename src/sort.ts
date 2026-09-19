/*
 * The sidebar ordering vocabulary, shared by the store, the server and the browser app.
 *
 * Kept in its own module with no imports: `store.ts` pulls in `node:fs`, so a client that imported
 * the keys from there would drag Node built-ins into the browser bundle. Both sides therefore read
 * the definition from here, which also keeps the API's validation and the UI's labels from drifting.
 */

/**
 * How a space's pages are ordered in the sidebar and in `GET /api/tree`. The order is derived from
 * page data rather than from `readdirSync`: directory order is creation order only on small ext4
 * directories, and becomes hash order on APFS/NTFS or once a directory gains an htree — so a
 * sidebar built on it can reshuffle for no reason the user can see.
 */
export type SortKey = 'created_desc' | 'created_asc' | 'updated_desc' | 'updated_asc' | 'title_asc';

/** Newest first: matches how the shipped sample is laid out, and makes a new page appear on top. */
export const DEFAULT_SORT: SortKey = 'created_desc';

export const SORT_KEYS: readonly SortKey[] = [
  'created_desc', 'created_asc', 'updated_desc', 'updated_asc', 'title_asc',
];

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);
}

/** Human labels for the picker. The stored values stay a stable enum, so these can change freely. */
export const SORT_LABELS: Record<SortKey, string> = {
  created_desc: '最新创建在前',
  created_asc: '最早创建在前',
  updated_desc: '最近编辑在前',
  updated_asc: '最久未编辑在前',
  title_asc: '标题顺序',
};
