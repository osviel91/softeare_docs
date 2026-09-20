/**
 * Bringing a source range into view in a text editor.
 *
 * Search results and (later) diagnostics and outline entries all need the same
 * thing: "select this range and scroll to it". The request is modelled as a value
 * the editor props carry, rather than as a callback the editor exposes, so the
 * shell stays the single owner of what is being revealed.
 */

/** A source range to reveal in a text editor. */
export interface EditorReveal {
  /** 0-based character offset of the start of the range. */
  start: number;
  /** Exclusive end offset of the range. */
  end: number;
  /** The text the range is expected to hold, used to confirm the buffer loaded. */
  text: string;
  /** 1-based line number, used to scroll the range into view. */
  line: number;
  /**
   * Changes on every request. Revealing the same range twice must still re-run,
   * and a range is not identifiable by its offsets alone.
   */
  token: number;
}
