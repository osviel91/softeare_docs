/**
 * Fuzzy subsequence matching for Quick Open.
 *
 * Quick Open must answer "which resource, symbol or heading is the user after?"
 * from a handful of keystrokes, so the matcher favours what a human eye favours:
 * matches at word starts, runs of adjacent characters, and a match that begins
 * the name. The module is deliberately pure and framework-free — no React, no
 * workspace — so the ranking can be reasoned about and tested in isolation.
 *
 * Token rule: the query is split on whitespace and every token must be a
 * case-insensitive subsequence of the target. Tokens are first matched left to
 * right, each one in the text remaining after the previous token's last
 * character, so `pay aut` finds `Payment Authorization` with `aut` matched
 * inside `Authorization`. When that ordered pass fails, the tokens are retried
 * independently and their positions merged, so a transposed query such as
 * `aut pay` still finds the same item. The ordered pass runs first because it
 * produces the more intuitive highlight.
 */

/** A successful subsequence match, with a score and the matched indices. */
export interface FuzzyMatch {
  /** Higher is better; only comparisons between scores are meaningful. */
  score: number;
  /** Indices into the target of every matched character, ascending. */
  positions: number[];
}

/** Points awarded for every matched character. */
const MATCH_POINTS = 1;
/** Extra points when a matched character begins a word (see {@link isWordStart}). */
const BOUNDARY_BONUS = 8;
/** Extra points when a matched character directly follows the previous match. */
const CONSECUTIVE_BONUS = 6;
/** Extra points when the match covers the very first character of the target. */
const START_BONUS = 10;
/** Points removed for every target character skipped between two matches. */
const GAP_PENALTY = 1;
/** Points removed per target character, so equal matches prefer shorter keys. */
const LENGTH_PENALTY = 0.1;

/** Characters that begin a new word inside a target. */
const WORD_SEPARATORS = new Set(["-", "_", "/", " "]);

/** True for an ASCII lowercase letter; used for camelCase boundaries. */
function isLowercase(character: string): boolean {
  return character >= "a" && character <= "z";
}

/** True for an ASCII uppercase letter; used for camelCase boundaries. */
function isUppercase(character: string): boolean {
  return character >= "A" && character <= "Z";
}

/**
 * True when `index` begins a word of `target`: the first character, a character
 * after one of `- _ / space`, or a lowercase-to-uppercase transition. These are
 * the places a reader perceives as a new word, so a match there is worth more
 * than one buried mid-word.
 */
function isWordStart(target: string, index: number): boolean {
  if (index === 0) return true;
  const previous = target[index - 1];
  if (WORD_SEPARATORS.has(previous)) return true;
  return isLowercase(previous) && isUppercase(target[index]);
}

/**
 * Greedily find `token` in the already-lowercased `target`, starting at `from`.
 * Returns the matched indices, or null when the token is not a subsequence.
 * Greedy (leftmost) matching keeps the result deterministic; it is not always
 * the highest-scoring alignment, but it is predictable and cheap.
 */
function findToken(
  lowerTarget: string,
  token: string,
  from: number,
): number[] | null {
  const positions: number[] = [];
  let cursor = from;
  for (let index = 0; index < token.length; index += 1) {
    const found = lowerTarget.indexOf(token[index], cursor);
    if (found === -1) return null;
    positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

/**
 * Match every token in order, each in the text after the previous token. This
 * is the primary pass: it yields monotonically increasing positions, which the
 * scorer and the highlighter both expect.
 */
function matchTokensInOrder(
  lowerTarget: string,
  tokens: string[],
): number[] | null {
  const positions: number[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const found = findToken(lowerTarget, token, cursor);
    if (found === null) return null;
    positions.push(...found);
    cursor = found[found.length - 1] + 1;
  }
  return positions;
}

/**
 * Fallback pass: match every token anywhere in the target, then merge the
 * positions. It exists only so word order does not hide an otherwise obvious
 * hit; the merged positions are sorted and de-duplicated before scoring.
 */
function matchTokensAnywhere(
  lowerTarget: string,
  tokens: string[],
): number[] | null {
  const merged: number[] = [];
  for (const token of tokens) {
    const found = findToken(lowerTarget, token, 0);
    if (found === null) return null;
    merged.push(...found);
  }
  return [...new Set(merged)].sort((a, b) => a - b);
}

/**
 * Score an ascending, de-duplicated list of matched positions. The numbers are
 * documented on the constants above; the only contract that matters is the
 * ordering they induce: a start-of-target run beats a word-boundary run beats a
 * mid-word run, adjacency beats gaps, and equal matches prefer shorter targets.
 */
function scorePositions(target: string, positions: number[]): number {
  let score = 0;
  let previous = -1;
  for (const index of positions) {
    score += MATCH_POINTS;
    if (index === 0) score += START_BONUS;
    if (isWordStart(target, index)) score += BOUNDARY_BONUS;
    if (previous >= 0) {
      const gap = index - previous - 1;
      if (gap === 0) score += CONSECUTIVE_BONUS;
      else score -= gap * GAP_PENALTY;
    }
    previous = index;
  }
  return score - target.length * LENGTH_PENALTY;
}

/** Match `query` against `target` as a case-insensitive subsequence, or null. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const trimmed = query.trim();
  // An empty query is a "browse" request: everything matches for free, and the
  // caller decides the display order.
  if (trimmed === "") return { score: 0, positions: [] };

  const lowerTarget = target.toLowerCase();
  const tokens = trimmed.toLowerCase().split(/\s+/);
  const positions =
    matchTokensInOrder(lowerTarget, tokens) ??
    matchTokensAnywhere(lowerTarget, tokens);
  if (positions === null) return null;

  return { score: scorePositions(target, positions), positions };
}

/** Rank `items` against `query`, best first, dropping non-matches. */
export function fuzzyRank<T>(
  items: T[],
  query: string,
  key: (item: T) => string,
): Array<{ item: T; score: number; positions: number[] }> {
  // An empty query keeps the caller's order exactly (the browse list); using
  // the comparator below would reorder it by key length, which is not wanted.
  if (query.trim() === "") {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }

  const ranked: Array<{
    item: T;
    index: number;
    length: number;
    score: number;
    positions: number[];
  }> = [];

  items.forEach((item, index) => {
    const text = key(item);
    const match = fuzzyMatch(query, text);
    if (match === null) return;
    ranked.push({
      item,
      index,
      length: text.length,
      score: match.score,
      positions: match.positions,
    });
  });

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // Equal quality: the shorter key is the more specific answer, and the
    // original index keeps the result stable and deterministic.
    if (a.length !== b.length) return a.length - b.length;
    return a.index - b.index;
  });

  return ranked.map(({ item, score, positions }) => ({
    item,
    score,
    positions,
  }));
}
