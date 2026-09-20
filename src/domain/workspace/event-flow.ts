/**
 * Defaults for the event-flow file kind.
 *
 * Mirrors `diagram.ts` and `note.ts`: the same starting file name and the same
 * collision strategy, so an event flow created in-browser and one created in a
 * local folder look the same. The extension is what tells the two diagram
 * languages apart in a folder project — and, because the in-browser store keeps
 * the name too, everywhere else as well.
 */

/** The extension an event-flow document carries. */
export const EVENT_FLOW_EXTENSION = ".eventseq";

/** The file name a freshly created event flow starts with. */
export const EMPTY_EVENT_FLOW_NAME = `Untitled${EVENT_FLOW_EXTENSION}`;

/** Whether a file name denotes an event flow rather than a sequence diagram. */
export function isEventFlowName(name: string): boolean {
  return name.toLowerCase().endsWith(EVENT_FLOW_EXTENSION);
}

/**
 * Pick an event-flow file name that is not already taken in a project.
 *
 * `Untitled.eventseq` when free, else `Untitled 2.eventseq`, ... so creating
 * several in a row never clobbers an earlier one.
 */
export function uniqueEventFlowName(existing: string[]): string {
  if (!existing.includes(EMPTY_EVENT_FLOW_NAME)) return EMPTY_EVENT_FLOW_NAME;
  let index = 2;
  while (existing.includes(`Untitled ${index}${EVENT_FLOW_EXTENSION}`)) {
    index += 1;
  }
  return `Untitled ${index}${EVENT_FLOW_EXTENSION}`;
}
