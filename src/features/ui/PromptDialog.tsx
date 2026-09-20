/**
 * A single-field prompt dialog, used by the explorer's rename and change-title
 * actions.
 *
 * It is a controlled component like {@link ConfirmDialog}: it owns only the
 * in-progress text and reports the submitted value, so the caller decides what a
 * rename or title means. Enter submits, Escape cancels, the input is focused and
 * pre-selected on open, and an empty value is rejected so a file can never lose
 * its name.
 */
import { useState, type FormEvent } from "react";

export interface PromptDialogProps {
  /** Heading, e.g. `Rename diagram`. */
  title: string;
  /** Label for the input. */
  label: string;
  /** Initial input value. */
  initialValue?: string;
  /** Confirm button label. Defaults to "Save". */
  confirmLabel?: string;
  /** Placeholder for the input. */
  placeholder?: string;
  /** Called with the trimmed value when the form is submitted. */
  onConfirm: (value: string) => void;
  /** Dismiss without changing anything. */
  onCancel: () => void;
}

export default function PromptDialog({
  title,
  label,
  initialValue = "",
  confirmLabel = "Save",
  placeholder,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed === "") return;
    onConfirm(trimmed);
  };

  return (
    <div
      className="dialog-overlay"
      data-testid="prompt-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
        data-testid="prompt-dialog"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 className="dialog__title" id="prompt-dialog-title">
          {title}
        </h2>
        <label className="dialog__field">
          <span className="dialog__label">{label}</span>
          <input
            autoFocus
            className="dialog__input"
            data-testid="prompt-dialog-input"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.target.select()}
          />
        </label>
        <div className="dialog__actions">
          <span className="dialog__spacer" />
          <button
            type="button"
            className="button button--ghost"
            data-testid="prompt-dialog-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            data-testid="prompt-dialog-confirm"
            disabled={trimmed === ""}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
