import type { CatalogSongPage } from "../../contracts/catalog";
import type { CatalogEntityPage } from "../../contracts/catalogBrowse";

type Page = CatalogSongPage | CatalogEntityPage;

/** Repage upstream batches without losing their overflow or refetching on Back. */
export function recommendationPages(read: (generation: number, page: number) => Promise<Page>, size: number) {
  const pages: Page[] = [];
  let batch: Page | undefined, offset = 0, sourcePage = 0;
  let queue = Promise.resolve();
  async function append(generation: number) {
    let current = batch, cursor = offset, source = sourcePage, fetched = false;
    const items: (CatalogSongPage["items"][number] | CatalogEntityPage["items"][number])[] = [];
    const used = new Set<Page>();
    while (items.length < size) {
      if (!current || cursor === current.items.length) {
        if (fetched || (current && (!current.hasMore || source === 100))) break;
        const next = await read(generation, source + 1);
        if (next.generation !== generation) throw new Error("stale_recommendations");
        current = next; source++; cursor = 0; fetched = true;
        // An empty upstream page remains reviewable, with its warning and Next.
        if (!current.items.length) { used.add(current); break; }
      }
      used.add(current);
      const count = Math.min(size - items.length, current.items.length - cursor);
      items.push(...current.items.slice(cursor, cursor + count)); cursor += count;
    }
    if (!current) throw new Error("missing_recommendations");
    // Commit the cursor only after the whole page succeeds, so a failed read
    // cannot consume the overflow reserved for this page.
    batch = current; offset = cursor; sourcePage = source;
    pages.push({ ...current, items, page: pages.length + 1,
      warningCount: [...used].reduce((sum, page) => sum + page.warningCount, 0),
      hasMore: offset < current.items.length || (current.hasMore && sourcePage < 100),
    } as Page);
  }
  return (page: number, generation: number): Promise<Page> => {
    const result = queue.then(async () => {
      while (pages.length < page && (pages.at(-1)?.hasMore ?? true)) await append(generation);
      const cached = pages[page - 1];
      if (!cached) throw new Error("recommendation_page_out_of_range");
      return { ...cached, generation };
    });
    queue = result.then(() => {}, () => {});
    return result;
  };
}
