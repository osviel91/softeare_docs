import type { MessageNode, SequenceDiagram } from "./ast";
import { walkStatements } from "./ast";

/** One evidence-backed architectural message occurrence in a Sequence. */
export interface SemanticMessageOccurrence {
  name: string;
  kind: "event" | "command";
  operation: "publish" | "consume" | "dispatch";
  from: string;
  to: string;
  step: number;
  range: MessageNode["range"];
}

/** Extract local occurrences; equal names are deliberately not resolved. */
export function semanticMessagesOf(
  diagram: SequenceDiagram,
): SemanticMessageOccurrence[] {
  const occurrences: SemanticMessageOccurrence[] = [];
  let step = 0;
  for (const statement of walkStatements(diagram.statements)) {
    if (statement.type !== "message") continue;
    step += 1;
    if (!statement.semantics) continue;
    occurrences.push({
      name: statement.semantics.name,
      kind: statement.semantics.kind,
      operation: statement.semantics.operation,
      from: statement.from,
      to: statement.to,
      step,
      range: statement.range,
    });
  }
  return occurrences;
}
