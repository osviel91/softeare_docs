/**
 * Export dialog: choose a format and its options, then export.
 *
 * The dialog is a controlled view over the current document's SVG. It owns only
 * the transient option state (format, theme, background, scale, padding, title)
 * and reports the chosen {@link DiagramExportOptions} through `onExport` (or its
 * `onConfirm` alias); the shell owns the actual re-render and download, because
 * only the shell has the AST that a theme or padding change must be re-rendered
 * from.
 *
 * When no handler is supplied the dialog falls back to saving the SVG it was
 * given (rasterizing it for PNG/PDF), which keeps the component usable on its
 * own. That fallback cannot apply theme/background/padding — those need the AST
 * — so a shell that wants them honoured must pass `onExport`.
 *
 * Keyboard behaviour follows the house modal convention: Escape cancels,
 * clicking the backdrop dismisses, and focus starts on the export button.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { downloadBytes } from "../../workspace/transfer/download";
import {
  exportFileName,
  exportMimeType,
  normalizeScale,
  svgToPdf,
  svgToPng,
  type DiagramExportOptions,
} from "./diagram-export";

export interface ExportDialogProps {
  /** The SVG for the current document, already rendered. */
  svg: string;
  width: number;
  height: number;
  /** The document's display name, used as the default file name stem. */
  name: string;
  onClose: () => void;
  /**
   * Receive the chosen export options. The shell re-renders the diagram with
   * them (so theme, background and padding take effect) and saves the bytes.
   * When omitted the dialog saves the SVG it was given itself.
   */
  onExport?: (options: DiagramExportOptions) => void;
  /**
   * Alias for {@link ExportDialogProps.onExport}, matching the `onConfirm`
   * naming the other house dialogs use. `onExport` wins when both are given.
   */
  onConfirm?: (options: DiagramExportOptions) => void;
}

/** Background choices offered by the select. */
type BackgroundChoice = "white" | "transparent" | "custom";

/** One option button in a segmented group. */
interface OptionButtonProps {
  testId: string;
  selected: boolean;
  label: string;
  onClick: () => void;
}

/** A single pressed-state button, used for the format and theme groups. */
function OptionButton({ testId, selected, label, onClick }: OptionButtonProps) {
  return (
    <button
      type="button"
      className={`button${selected ? " button--primary" : " button--ghost"}`}
      data-testid={testId}
      aria-pressed={selected}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** A labelled form row: a small caption above its control. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: "var(--text-faint)",
      }}
    >
      {label}
      {children}
    </label>
  );
}

export default function ExportDialog({
  svg,
  width,
  height,
  name,
  onClose,
  onExport,
  onConfirm,
}: ExportDialogProps) {
  const [format, setFormat] = useState<DiagramExportOptions["format"]>("svg");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [background, setBackground] = useState<BackgroundChoice>("white");
  const [customBackground, setCustomBackground] = useState("#ffffff");
  const [scale, setScale] = useState(2);
  const [padding, setPadding] = useState(0);
  const [includeTitle, setIncludeTitle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Focus the primary action on open, like the other house dialogs.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const options = useMemo<DiagramExportOptions>(
    () => ({
      format,
      theme,
      background:
        background === "custom"
          ? customBackground.trim() || "white"
          : background,
      scale: normalizeScale(scale),
      padding: Math.max(0, padding),
      includeTitle,
      title: name,
    }),
    [
      format,
      theme,
      background,
      customBackground,
      scale,
      padding,
      includeTitle,
      name,
    ],
  );

  const previewUrl = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    [svg],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const handleConfirm = async () => {
    const handler = onExport ?? onConfirm;
    if (handler) {
      handler(options);
      onClose();
      return;
    }
    // Fallback: save the SVG the dialog was handed. Options that require a
    // re-render (theme, background, padding) cannot be applied here.
    setBusy(true);
    setError(null);
    try {
      const bytes =
        options.format === "svg"
          ? new TextEncoder().encode(svg)
          : options.format === "png"
            ? await svgToPng(svg, width, height, options.scale ?? 2)
            : await svgToPdf(svg, width, height, options.scale ?? 2);
      downloadBytes(
        bytes,
        exportFileName(options),
        exportMimeType(options.format),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="palette-overlay"
      data-testid="export-overlay"
      onMouseDown={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Export diagram"
        data-testid="export-dialog"
        style={{ maxHeight: "80vh", overflowY: "auto", padding: 18, gap: 14 }}
      >
        <h2 style={{ margin: 0, fontSize: 15 }}>Export diagram</h2>

        <img
          data-testid="export-preview"
          src={previewUrl}
          alt="Diagram preview"
          style={{
            maxWidth: "100%",
            maxHeight: "30vh",
            alignSelf: "center",
            background:
              background === "transparent" ? "transparent" : customBackground,
          }}
        />

        <Row label="Format">
          <div style={{ display: "flex", gap: 6 }}>
            <OptionButton
              testId="export-format-svg"
              selected={format === "svg"}
              label="SVG"
              onClick={() => setFormat("svg")}
            />
            <OptionButton
              testId="export-format-png"
              selected={format === "png"}
              label="PNG"
              onClick={() => setFormat("png")}
            />
            <OptionButton
              testId="export-format-pdf"
              selected={format === "pdf"}
              label="PDF"
              onClick={() => setFormat("pdf")}
            />
          </div>
        </Row>

        <Row label="Theme">
          <div style={{ display: "flex", gap: 6 }}>
            <OptionButton
              testId="export-theme-light"
              selected={theme === "light"}
              label="Light"
              onClick={() => setTheme("light")}
            />
            <OptionButton
              testId="export-theme-dark"
              selected={theme === "dark"}
              label="Dark"
              onClick={() => setTheme("dark")}
            />
          </div>
        </Row>

        <Row label="Background">
          <select
            data-testid="export-background"
            value={background}
            onChange={(event) =>
              setBackground(event.target.value as BackgroundChoice)
            }
          >
            <option value="white">White (theme paper)</option>
            <option value="transparent">Transparent</option>
            <option value="custom">Custom colour…</option>
          </select>
        </Row>

        {background === "custom" && (
          <Row label="Custom colour">
            <input
              type="text"
              data-testid="export-background-custom"
              value={customBackground}
              onChange={(event) => setCustomBackground(event.target.value)}
              placeholder="#ffffff"
            />
          </Row>
        )}

        <div style={{ display: "flex", gap: 14 }}>
          <Row label="Scale">
            <input
              type="number"
              data-testid="export-scale"
              min={1}
              max={8}
              step={0.5}
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
            />
          </Row>
          <Row label="Padding (px)">
            <input
              type="number"
              data-testid="export-padding"
              min={0}
              step={1}
              value={padding}
              onChange={(event) => setPadding(Number(event.target.value))}
            />
          </Row>
        </div>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            data-testid="export-include-title"
            checked={includeTitle}
            onChange={(event) => setIncludeTitle(event.target.checked)}
          />
          Include title
        </label>

        {error && (
          <p
            data-testid="export-error"
            role="alert"
            style={{ margin: 0, fontSize: 12, color: "var(--danger, #f87171)" }}
          >
            {error}
          </p>
        )}

        <div
          className="palette__footer"
          style={{ padding: 0, borderTop: "none" }}
        >
          <span className="palette__hint" data-testid="export-file-name">
            {exportFileName(options)}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            className="button button--ghost"
            data-testid="export-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="button button--primary"
            data-testid="export-confirm"
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
