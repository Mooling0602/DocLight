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
export type SortKey = 'created_desc' | 'created_asc' | 'updated_desc' | 'updated_asc' | 'title_asc' | 'manual';

/** Newest first: matches how the shipped sample is laid out, and makes a new page appear on top. */
export const DEFAULT_SORT: SortKey = 'created_desc';

export const SORT_KEYS: readonly SortKey[] = [
  'created_desc', 'created_asc', 'updated_desc', 'updated_asc', 'title_asc', 'manual',
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
  manual: '手动排序',
};

/**
 * Previous/next page in reading order, used by the "recommend other articles" footer.
 *
 * The walk is depth-first over the space's page tree, and each level keeps the order the server
 * returned (the space's sort key). That is the order the sidebar shows: a child page reads right
 * after its parent and before the parent's next sibling — not a flat list where a nested page
 * would jump to the end of the space.
 *
 * A hand-edited cycle or a dangling `parent` must not hang or hide the reader, so unvisited pages
 * are appended in tree order and the walk never enters a slug twice.
 */
export function pageNeighbors<T extends { slug: string; space: string; parent: string | null }>(
  pages: readonly T[],
  slug: string,
): { prev: T | null; next: T | null } {
  const current = pages.find((page) => page.slug === slug);
  if (!current) return { prev: null, next: null };

  const order: T[] = [];
  const seen = new Set<string>();
  const childrenOf = (parent: string | null): T[] =>
    pages.filter((page) => page.space === current.space && (page.parent ?? null) === parent);
  const walk = (parent: string | null): void => {
    for (const child of childrenOf(parent)) {
      if (seen.has(child.slug)) continue;
      seen.add(child.slug);
      order.push(child);
      walk(child.slug);
    }
  };
  walk(null);
  for (const page of pages) {
    if (page.space !== current.space || seen.has(page.slug)) continue;
    seen.add(page.slug);
    order.push(page);
  }

  const index = order.findIndex((page) => page.slug === slug);
  return {
    prev: index > 0 ? order[index - 1] : null,
    next: index >= 0 && index < order.length - 1 ? order[index + 1] : null,
  };
}


/**
 * Apply a space's manual order to its pages.
 *
 * The stored array lists slugs in reading order; anything missing (a page created after the order
 * was written, or a hand-edited stale entry) keeps its incoming relative position after the listed
 * ones. `Array.prototype.sort` is stable, so ties preserve the order the pages were read in.
 */
export function applyManualOrder<T extends { slug: string }>(pages: readonly T[], order?: readonly string[]): T[] {
  if (!order || order.length === 0) return [...pages];
  const rank = new Map<string, number>();
  order.forEach((slug, index) => { if (!rank.has(slug)) rank.set(slug, index); });
  const unlisted = Number.MAX_SAFE_INTEGER;
  return [...pages].sort((a, b) => (rank.get(a.slug) ?? unlisted) - (rank.get(b.slug) ?? unlisted));
}
