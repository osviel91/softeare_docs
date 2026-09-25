/** Deterministic, font-independent text measurement used by diagram layouts. */
export function estimateTextWidth(text: string, fontSize = 13): number {
  return text.length * fontSize * 0.55;
}

export function wrapText(text: string, maxWidth: number, fontSize = 13): string[] {
  const limit = Math.max(1, Math.floor(maxWidth / (fontSize * 0.55)));
  return text.split("\n").flatMap((line) => {
    if (!line) return [""];
    const words = line.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
      } else if ((current.length + word.length + 1) <= limit) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines.flatMap((item) => {
      if (item.length <= limit) return [item];
      const chunks: string[] = [];
      for (let index = 0; index < item.length; index += limit) {
        chunks.push(item.slice(index, index + limit));
      }
      return chunks;
    });
  });
}
