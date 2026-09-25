/** Deterministic, font-independent text measurement used by diagram layouts. */
export function estimateTextWidth(text: string, fontSize = 13): number {
  return text.length * fontSize * 0.55;
}

function identifierTokens(word: string): string[] | null {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(word)) return null;
  const parts = word
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  return parts.length > 1 ? parts : null;
}

function splitLongWord(word: string, limit: number): string[] {
  if (word.length <= limit) return [word];
  const tokens = identifierTokens(word);
  if (!tokens) {
    const chunks: string[] = [];
    for (let index = 0; index < word.length; index += limit) {
      chunks.push(word.slice(index, index + limit));
    }
    return chunks;
  }
  return tokens.flatMap((token) => splitLongWord(token, limit));
}

function balancedLines(words: string[], limit: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + word.length + 1 <= limit) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  // Move trailing tokens back when that makes adjacent identifier lines more even.
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const previous = lines[index - 1].split(" ");
    const currentWords = lines[index].split(" ");
    while (previous.length > 1 && currentWords.length > 0) {
      const before = Math.abs(lines[index - 1].length - lines[index].length);
      const moved = previous.at(-1)!;
      const nextPrevious = previous.slice(0, -1).join(" ");
      const nextCurrent = [moved, ...currentWords].join(" ");
      if (nextCurrent.length > limit) break;
      const after = Math.abs(nextPrevious.length - nextCurrent.length);
      if (after >= before) break;
      previous.pop();
      currentWords.unshift(moved);
      lines[index - 1] = previous.join(" ");
      lines[index] = currentWords.join(" ");
    }
  }
  return lines.filter(Boolean);
}

export function wrapText(text: string, maxWidth: number, fontSize = 13): string[] {
  const limit = Math.max(1, Math.floor(maxWidth / (fontSize * 0.55)));
  return text.split("\n").flatMap((line) => {
    if (!line) return [""];
    const words = line
      .split(/\s+/)
      .flatMap((word) => splitLongWord(word, limit));
    return balancedLines(words, limit);
  });
}
