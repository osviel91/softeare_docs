/**
 * Confirmation dialog for destructive actions.
 *
 * Deleting a project or a diagram cannot be undone by the user, so it always
 * goes through this dialog instead of firing on a bare click. The dialog is a
 * small, controlled component: it owns no state and only reports intent through
 * its callbacks, so the caller decides what "confirm" means.
 *
 * Two confirms are supported. The primary `onConfirm` is the destructive action
 * (delete). An optional `onAlternative` offers a non-destructive variant — used
 * for "remove from the app but keep the file on disk" when a local folder is
 * open. When no alternative is supplied the dialog shows a single confirm.
 *
 * Keyboard behaviour follows the platform convention for modal dialogs: Escape
 * cancels and focus starts on the destructive action so a keyboard user can
 * confirm (or, more safely, Tab away) without reaching for the pointer.
 */
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

export interface ConfirmDialogProps {
  /** Short heading, e.g. `Delete project “Onboarding”?`. */
  title: string;
  /** One or two sentences explaining what happens. */
  message: string;
  /** Label for the destructive action, e.g. "Delete". */
  confirmLabel: string;
  /** Run the destructive action. */
  onConfirm: () => void;
  /** Dismiss without doing anything (Escape, backdrop, or Cancel). */
  onCancel: () => void;
  /**
   * Optional non-destructive confirm, e.g. "Remove from app". When supplied the
   * dialog renders three actions: alternative, cancel, and confirm.
   */
  alternativeLabel?: string;
  /** Run the non-destructive action. Required when `alternativeLabel` is set. */
  onAlternative?: () => void;
  /**
   * Heading id prefix for `aria-labelledby`/`aria-describedby`. Defaults to a
   * fixed string, which is fine because only one dialog is open at a time.
   */
  idPrefix?: string;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  alternativeLabel,
  onAlternative,
  idPrefix = "confirm-dialog",
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `${idPrefix}-title`;
  const messageId = `${idPrefix}-message`;

  // Focus the destructive action on open, like a native confirm sheet. The
  // button is guaranteed to exist on mount, so no null dance is needed.
  useEffect(() => {
    confirmRef.current?.focus();
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

  // A click on the backdrop itself (not on the panel) dismisses the dialog.
  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onCancel();
  };

  return (
    <div
      className="dialog-overlay"
      data-testid="confirm-dialog-overlay"
      onMouseDown={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        data-testid="confirm-dialog"
      >
        <h2 className="dialog__title" id={titleId}>
          {title}
        </h2>
        <p className="dialog__message" id={messageId}>
          {message}
        </p>
        <div className="dialog__actions">
          {alternativeLabel && onAlternative && (
            <button
              type="button"
              className="button"
              data-testid="confirm-dialog-alternative"
              onClick={onAlternative}
            >
              {alternativeLabel}
            </button>
          )}
          <span className="dialog__spacer" />
          <button
            type="button"
            className="button button--ghost"
            data-testid="confirm-dialog-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="button button--danger"
            data-testid="confirm-dialog-confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
