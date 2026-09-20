/**
 * Quick Open item model.
 *
 * A {@link QuickOpenItem} is anything the Cmd/Ctrl+P overlay can reveal: a
 * diagram, a markdown document, a symbol inside either, or a heading inside a
 * document. The overlay itself is content-agnostic — it only needs a label to
 * show, a group to bucket rows, and a `search` string to rank against — so this
 * module owns the shape and the one pure ranking helper, and the shell decides
 * how a workspace becomes a list of items.
 */
import { fuzzyRank } from "./fuzzy";

/** Something the user can open by name. */
export interface QuickOpenItem {
  /** Stable id: the resource id, or `<resourceId>#<symbolId>`. */
  id: string;
  /** The primary text shown and searched, e.g. "Payment Processing". */
  label: string;
  /** Secondary text, e.g. the file path or "participant · payment.seq". */
  detail?: string;
  /** Groups rows in the list: "Diagrams", "Documents", "Symbols", "Headings". */
  group: string;
  /**
   * The key the matcher searches against: label plus detail. `label` must be a
   * prefix of `search` (build it as `` `${label} ${detail}` ``) so that the
   * match positions returned by {@link rankItems} line up with the label the
   * overlay highlights.
   */
  search: string;
}

/**
 * Rank items for `query` using {@link fuzzyRank} over `item.search`.
 *
 * For a real query the quality ranking wins outright, so a strong match in a
 * later group rises above a weak match in an earlier one. For an empty or
 * whitespace-only query there is no ranking to do, so the input order is
 * returned unchanged: that order is the caller's browse order, which groups
 * items by `group` for display.
 */
export function rankItems(
  items: QuickOpenItem[],
  query: string,
): Array<{ item: QuickOpenItem; positions: number[] }> {
  return fuzzyRank(items, query, (item) => item.search).map(
    ({ item, positions }) => ({ item, positions }),
  );
}
