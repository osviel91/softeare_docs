/**
 * The dialog shown when a save loses a race (Phase 4A).
 *
 * A `409` is the one failure that must not be reported as an error, because
 * nothing the user typed is wrong: the document simply changed underneath them.
 * The dialog's job is to make the choice explicit and to never pretend a merge
 * happened. Three honest outcomes are offered:
 *
 * - **Reload server version** — discard the local buffer and take what the server
 *   holds. The safe default, and the one focus starts on.
 * - **Keep my changes** — overwrite the server's version with the local buffer.
 *   The user has been told, so this is a deliberate choice rather than a silent
 *   clobber; the label says what will happen instead of hiding behind "keep".
 * - **Copy my changes** — put the buffer on the clipboard so it can be pasted
 *   into the reloaded document by hand. This is the exit for a user who wants
 *   neither of the first two yet.
 *
 * Cancelling (Escape, the backdrop, or the button) keeps the buffer exactly as it
 * is: still dirty, still in the editor, and still in the tab.
 */
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

export interface SaveConflictDialogProps {
  /** The file the conflict concerns, for the heading. */
  documentName: string;
  /** The server's explanation, shown verbatim. */
  message: string;
  /** True after the local buffer has been copied, to confirm it happened. */
  copied?: boolean;
  /** Replace the editor buffer with the server's current content. */
  onReload: () => void;
  /** Overwrite the server's content with the local buffer. */
  onKeepMine: () => void;
  /** Put the local buffer on the clipboard. */
  onCopyMine: () => void;
  /** Dismiss without resolving; the buffer stays dirty. */
  onCancel: () => void;
}

export default function SaveConflictDialog({
  documentName,
  message,
  copied = false,
  onReload,
  onKeepMine,
  onCopyMine,
  onCancel,
}: SaveConflictDialogProps) {
  // Focus the safe action, not the destructive one: a keyboard user pressing
  // Enter should reload rather than overwrite a colleague's work.
  const reloadRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    reloadRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
      }
    },
    [onCancel],
  );

  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onCancel();
  };

  return (
    <div
      className="dialog-overlay"
      data-testid="save-conflict-overlay"
      onMouseDown={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="save-conflict-title"
        aria-describedby="save-conflict-message"
        data-testid="save-conflict-dialog"
      >
        <h2 className="dialog__title" id="save-conflict-title">
          This document has changed on the server
        </h2>
        <p className="dialog__message" id="save-conflict-message">
          {message}
        </p>
        <p className="dialog__message" data-testid="save-conflict-document">
          Your edits to “{documentName}” are still in the editor and have not
          been saved.
        </p>
        <div className="dialog__actions">
          <button
            type="button"
            className="button"
            data-testid="save-conflict-copy"
            onClick={onCopyMine}
          >
            {copied ? "Copied" : "Copy my changes"}
          </button>
          <span className="dialog__spacer" />
          <button
            type="button"
            className="button button--ghost"
            data-testid="save-conflict-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button"
            data-testid="save-conflict-keep"
            onClick={onKeepMine}
          >
            Keep my changes
          </button>
          <button
            ref={reloadRef}
            type="button"
            className="button button--primary"
            data-testid="save-conflict-reload"
            onClick={onReload}
          >
            Reload server version
          </button>
        </div>
      </div>
    </div>
  );
}
