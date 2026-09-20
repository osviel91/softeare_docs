import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import Editor from "../../../src/features/editor/Editor";
import {
  EVENT_FLOW_SNIPPETS,
  SEQUENCE_SNIPPETS,
} from "../../../src/features/editor/snippets";
import {
  completeAt,
  type CompletionItem,
} from "../../../src/domain/project/completion";
import { collectParticipantMentions } from "../../../src/domain/diagram/participant-mentions";
import { analyze } from "../../../src/language/analyze";
import { analyzeEventFlow } from "../../../src/language/eventflow/parser";
import {
  DiagnosticCode,
  type Diagnostic,
} from "../../../src/language/diagnostics/diagnostics";

describe("Editor", () => {
  it("renders a controlled textarea with the given value", () => {
    render(<Editor value="participant A" onChange={vi.fn()} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe("participant A");
  });

  it("reports edits through onChange", () => {
    const onChange = vi.fn();
    render(<Editor value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant B" },
    });
    expect(onChange).toHaveBeenCalledWith("participant B");
  });

  it("shows a clean-state hint when there are no diagnostics", () => {
    render(<Editor value="participant A\nA -> B: hi" onChange={vi.fn()} />);
    expect(screen.getByText("No problems detected.")).toBeInTheDocument();
    expect(screen.queryByTestId("dsl-diagnostics")).toBeNull();
  });

  it("lists diagnostics with their severity", () => {
    const diagnostics: Diagnostic[] = [
      {
        severity: "error",
        message: 'Unknown participant "Z"',
        code: DiagnosticCode.UnknownParticipant,
      },
    ];
    render(
      <Editor
        value="A -> Z: hi"
        onChange={vi.fn()}
        diagnostics={diagnostics}
      />,
    );
    const list = screen.getByTestId("dsl-diagnostics");
    expect(list).toBeInTheDocument();
    expect(screen.getByText('Unknown participant "Z"')).toBeInTheDocument();
  });
});

describe("Editor — line numbers", () => {
  it("shows one line number per source line", () => {
    render(
      <Editor
        value={"participant A\nparticipant B\nA -> B: hi"}
        onChange={vi.fn()}
      />,
    );
    const gutter = screen.getByTestId("editor-gutter");
    expect(gutter.querySelectorAll(".editor__line-number")).toHaveLength(3);
    expect(gutter.textContent).toBe("123");
  });

  it("grows the gutter as lines are added", () => {
    const { rerender } = render(<Editor value="a" onChange={vi.fn()} />);
    expect(
      screen
        .getByTestId("editor-gutter")
        .querySelectorAll(".editor__line-number"),
    ).toHaveLength(1);
    rerender(<Editor value={"a\nb\nc"} onChange={vi.fn()} />);
    expect(
      screen
        .getByTestId("editor-gutter")
        .querySelectorAll(".editor__line-number"),
    ).toHaveLength(3);
  });

  it("counts a trailing newline as its own line", () => {
    render(<Editor value={"a\n"} onChange={vi.fn()} />);
    expect(
      screen
        .getByTestId("editor-gutter")
        .querySelectorAll(".editor__line-number"),
    ).toHaveLength(2);
  });

  it("hides the gutter from assistive technology", () => {
    render(<Editor value="a" onChange={vi.fn()} />);
    expect(screen.getByTestId("editor-gutter")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

describe("Editor — step-number badges", () => {
  it("shows a circled number beside the line it is given for", () => {
    render(
      <Editor
        value={"a\nb\nc"}
        onChange={vi.fn()}
        lineBadges={
          new Map([
            [1, 1],
            [2, 2],
          ])
        }
      />,
    );
    const badges = screen.getAllByTestId("editor-step");
    expect(badges).toHaveLength(2);
    expect(badges.map((badge) => badge.textContent)).toEqual(["1", "2"]);
    expect(badges.map((badge) => badge.dataset.step)).toEqual(["1", "2"]);
  });

  it("shows no badges when the language numbers nothing", () => {
    render(<Editor value={"a\nb"} onChange={vi.fn()} />);
    expect(screen.queryAllByTestId("editor-step")).toEqual([]);
  });

  it("reserves the badge column on every line once there are step numbers", () => {
    // Every row takes the two-column layout, badge or not, so a line number
    // never moves as messages are typed.
    const { unmount } = render(
      <Editor
        value={"a\nb"}
        onChange={vi.fn()}
        lineBadges={new Map([[0, 1]])}
      />,
    );
    expect(
      screen
        .getByTestId("editor-gutter")
        .querySelectorAll(".editor__line-number--steps"),
    ).toHaveLength(2);
    unmount();

    render(<Editor value={"a\nb"} onChange={vi.fn()} />);
    expect(
      screen
        .getByTestId("editor-gutter")
        .querySelectorAll(".editor__line-number--steps"),
    ).toHaveLength(0);
  });
});

describe("Editor — snippets", () => {
  /** Open the snippet menu and choose the snippet whose label contains `label`. */
  function insertSnippet(label: string): void {
    fireEvent.click(screen.getByTestId("snippets-button"));
    const item = screen
      .getAllByTestId("snippet-item")
      .find((element) => element.textContent?.includes(label));
    if (!item) throw new Error(`no snippet labelled ${label}`);
    fireEvent.click(item);
  }

  it("keeps the menu closed until asked", () => {
    render(<Editor value="" onChange={vi.fn()} />);
    expect(screen.queryByTestId("snippets-menu")).toBeNull();
    fireEvent.click(screen.getByTestId("snippets-button"));
    expect(screen.getByTestId("snippets-menu")).toBeInTheDocument();
  });

  it("inserts a snippet at the caret and closes the menu", () => {
    const onChange = vi.fn();
    render(<Editor value="title Flow" onChange={onChange} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    // Caret at the end of the existing text.
    textarea.setSelectionRange(10, 10);
    insertSnippet("Participants");
    // A newline is added first so the fragment starts on its own line.
    expect(onChange).toHaveBeenCalledWith(
      "title Flow\nparticipant User\nparticipant API",
    );
    expect(screen.queryByTestId("snippets-menu")).toBeNull();
  });

  it("offers a title snippet that names the diagram", () => {
    const onChange = vi.fn();
    render(<Editor value="" onChange={onChange} />);
    insertSnippet("Title");
    expect(onChange).toHaveBeenCalledWith("title My Diagram");
  });

  it("does not add a leading newline on an empty document", () => {
    const onChange = vi.fn();
    render(<Editor value="" onChange={onChange} />);
    insertSnippet("Alias");
    expect(onChange).toHaveBeenCalledWith("alias U = User");
  });

  it("replaces the current selection", () => {
    const onChange = vi.fn();
    render(<Editor value="keep me" onChange={onChange} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    textarea.setSelectionRange(5, 7); // select "me"
    insertSnippet("Alias");
    expect(onChange).toHaveBeenCalledWith("keep \nalias U = User");
  });

  it("offers a snippet for every DSL construct", () => {
    render(<Editor value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("snippets-button"));
    const labels = screen
      .getAllByTestId("snippet-item")
      .map((item) => item.textContent ?? "");
    expect(labels.length).toBeGreaterThanOrEqual(20);
    const all = labels.join(" ");
    for (const expected of [
      "Title",
      "Participants",
      "Actor",
      "Labelled participant",
      "Alias",
      "Message",
      "Response",
      "Self message",
      "Note",
      "Spanning note",
      "Multiline note",
      "Note on message",
      "Activation",
      "Inline activation",
      "Loop",
      "Alt / else",
      "Opt",
      "Par / and",
      "Critical / option",
      "Break",
    ]) {
      expect(all, `missing snippet: ${expected}`).toContain(expected);
    }
  });

  it("keeps every snippet free of diagnostics once its lifelines exist", () => {
    // The snippets are hand-written, so guard them against drifting behind the
    // grammar: each one must analyze cleanly once its lifelines are declared.
    const STATEMENT_PRELUDE =
      "actor Caller\nparticipant User\nparticipant API\nparticipant DB\nparticipant Mail\nparticipant Queue\n";
    const sourceFor = (label: string, text: string): string => {
      if (label === "Alias") return `participant User\n${text}`;
      if (label === "Note on message") {
        return `${STATEMENT_PRELUDE}API ->> DB: Request\n${text}`;
      }
      if (
        ["Title", "Participants", "Actor", "Labelled participant"].includes(
          label,
        )
      ) {
        return text;
      }
      return `${STATEMENT_PRELUDE}\n${text}`;
    };

    for (const snippet of SEQUENCE_SNIPPETS) {
      expect(
        analyze(sourceFor(snippet.label, snippet.text)).diagnostics,
        `snippet "${snippet.label}" is not valid DSL`,
      ).toEqual([]);
    }
  });
});

describe("Editor — event-flow snippets", () => {
  /** Open the menu and choose the snippet whose label contains `label`. */
  function insertSnippet(label: string): void {
    fireEvent.click(screen.getByTestId("snippets-button"));
    const item = screen
      .getAllByTestId("snippet-item")
      .find((element) => element.textContent?.includes(label));
    if (!item) throw new Error(`no snippet labelled ${label}`);
    fireEvent.click(item);
  }

  it("offers the event-flow fragments, not the sequence ones", () => {
    render(
      <Editor value="" onChange={vi.fn()} snippets={EVENT_FLOW_SNIPPETS} />,
    );
    fireEvent.click(screen.getByTestId("snippets-button"));
    const all = screen
      .getAllByTestId("snippet-item")
      .map((item) => item.textContent ?? "")
      .join(" ");
    expect(all).toContain("Event");
    expect(all).toContain("Broker");
    expect(all).toContain("Publish");
    // A sequence-only construct must not be offered in an event flow.
    expect(all).not.toContain("Participants");
    expect(all).not.toContain("Activation");
  });

  it("inserts an event-flow declaration", () => {
    const onChange = vi.fn();
    render(
      <Editor value="" onChange={onChange} snippets={EVENT_FLOW_SNIPPETS} />,
    );
    insertSnippet("Broker");
    expect(onChange).toHaveBeenCalledWith("broker Kafka");
  });

  /**
   * The snippets are hand-written, so guard them against drifting behind the
   * grammar. A lifecycle warning ("has no producer") is fine for a lone
   * fragment; a syntax error is not.
   */
  it("keeps every event-flow snippet free of syntax errors", () => {
    const DECLS = [
      "broker Kafka",
      "topic orders on Kafka",
      "producer OrderService",
      "consumer BillingService",
      "event OrderCreated {",
      "  version: 1",
      "}",
    ].join("\n");

    const contextFor = (label: string, text: string): string => {
      if (label === "Title" || label === "Event" || label === "Broker") {
        return text;
      }
      if (["Topic", "Queue", "Stream"].includes(label)) {
        return `broker Kafka\n${text}`;
      }
      if (["Producer", "Consumer", "Service"].includes(label)) return text;
      // Every publish/consume spelling needs the names it references.
      return `${DECLS}\n${text}`;
    };

    for (const snippet of EVENT_FLOW_SNIPPETS) {
      const errors = analyzeEventFlow(
        contextFor(snippet.label, snippet.text),
      ).diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      expect(
        errors,
        `snippet "${snippet.label}" is not valid event-flow syntax`,
      ).toEqual([]);
    }
  });

  it("composes a warning-free flow from the snippets alone", () => {
    const pick = (label: string): string =>
      EVENT_FLOW_SNIPPETS.find((snippet) => snippet.label === label)!.text;
    const source = [
      pick("Title"),
      pick("Broker"),
      pick("Topic"),
      pick("Producer"),
      pick("Consumer"),
      pick("Event"),
      pick("Publish"),
      pick("Consume"),
    ].join("\n");
    expect(analyzeEventFlow(source).diagnostics).toEqual([]);
  });
});

describe("Editor — dropping a participant name", () => {
  /** A drag payload as the browser would deliver it. */
  function dragPayload(text: string) {
    return {
      dataTransfer: {
        types: ["text/plain"],
        getData: () => text,
        setData: vi.fn(),
        dropEffect: "",
      },
    };
  }

  it("inserts a dropped participant name at the caret", () => {
    const onChange = vi.fn();
    render(<Editor value={"participant \n"} onChange={onChange} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    textarea.setSelectionRange(12, 12);

    fireEvent.drop(textarea, dragPayload("API"));
    expect(onChange).toHaveBeenCalledWith("participant API\n");
  });

  it("shows a drop hint while a drag is over the editor", () => {
    render(<Editor value="" onChange={vi.fn()} />);
    const textarea = screen.getByTestId("dsl-textarea");
    fireEvent.dragOver(textarea, dragPayload("API"));
    expect(textarea).toHaveClass("editor__textarea--drop");
    fireEvent.dragLeave(textarea);
    expect(textarea).not.toHaveClass("editor__textarea--drop");
  });

  it("ignores a drop with no text payload", () => {
    const onChange = vi.fn();
    render(<Editor value="participant A" onChange={onChange} />);
    fireEvent.drop(screen.getByTestId("dsl-textarea"), {
      dataTransfer: { types: [], getData: () => "" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Editor — completion keyboard", () => {
  /**
   * A controlled editor whose value actually updates, like the shell's. The
   * plain `Editor` with a `vi.fn()` onChange would be reset by React on the
   * next render, which hides the behaviour under test.
   */
  function EditorHarness({
    initial = "",
    complete,
    onValue,
  }: {
    initial?: string;
    complete: (request: { source: string; offset: number }) => CompletionItem[];
    onValue?: (value: string) => void;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <Editor
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
        complete={complete}
      />
    );
  }

  /** The real root-keyword completion for a diagram with no project. */
  const keywords = (request: { source: string; offset: number }) =>
    completeAt({
      source: request.source,
      offset: request.offset,
      ast: null,
      symbols: [],
      resources: [],
    });

  /** One suggestion replacing a typed three-letter word. */
  const oneSuggestion = (): CompletionItem[] => [
    { label: "participant", kind: "keyword", replaceStart: 0, replaceEnd: 3 },
  ];

  it("does not pop up a wall of keywords on a blank line", () => {
    render(<EditorHarness complete={keywords} />);
    const textarea = screen.getByTestId("dsl-textarea");
    // Anything that makes the editor re-check the caret: a keyup or a click.
    fireEvent.keyUp(textarea, { key: "ArrowLeft" });
    expect(screen.queryByTestId("completions")).toBeNull();
  });

  it("opens once a word is being typed", () => {
    render(<EditorHarness complete={keywords} />);
    const textarea = screen.getByTestId("dsl-textarea");
    fireEvent.change(textarea, { target: { value: "pa" } });
    fireEvent.keyUp(textarea, { key: "a" });
    expect(screen.getByTestId("completions")).toBeInTheDocument();
    const offered = screen
      .getAllByTestId("completion-item")
      .map((item) => item.textContent ?? "")
      .join(" ");
    expect(offered).toContain("participant");
  });

  it("does not accept the top suggestion on Enter", () => {
    const onValue = vi.fn();
    render(
      <EditorHarness
        initial="par"
        complete={oneSuggestion}
        onValue={onValue}
      />,
    );
    const textarea = screen.getByTestId("dsl-textarea");
    fireEvent.keyUp(textarea, { key: "r" });
    expect(screen.getByTestId("completions")).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "Enter" });
    // Nothing was applied; the textarea keeps the key and inserts a newline
    // (which jsdom does not simulate), so a blank line stays possible.
    expect(onValue).not.toHaveBeenCalled();
  });

  it("accepts the highlighted suggestion on Enter", () => {
    const onValue = vi.fn();
    render(
      <EditorHarness
        initial="par"
        complete={oneSuggestion}
        onValue={onValue}
      />,
    );
    const textarea = screen.getByTestId("dsl-textarea");
    fireEvent.keyUp(textarea, { key: "r" });

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    // The matching keyup must not rebuild the list and undo the choice.
    fireEvent.keyUp(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onValue).toHaveBeenCalledWith("participant");
  });

  it("accepts the top suggestion on Tab without arming it first", () => {
    const onValue = vi.fn();
    render(
      <EditorHarness
        initial="par"
        complete={oneSuggestion}
        onValue={onValue}
      />,
    );
    const textarea = screen.getByTestId("dsl-textarea");
    fireEvent.keyUp(textarea, { key: "r" });

    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(onValue).toHaveBeenCalledWith("participant");
  });

  it("closes the popup on Escape", () => {
    render(<EditorHarness initial="par" complete={oneSuggestion} />);
    const textarea = screen.getByTestId("dsl-textarea");
    fireEvent.keyUp(textarea, { key: "r" });
    expect(screen.getByTestId("completions")).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.keyUp(textarea, { key: "Escape" });
    expect(screen.queryByTestId("completions")).toBeNull();
  });
});

describe("Editor — participant highlighting and live rename", () => {
  /** A controlled editor wired to participant spans, as the shell wires it. */
  function MentionsHarness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    const { ast } = analyze(value);
    const mentions = ast ? collectParticipantMentions(ast, value) : [];
    return <Editor value={value} onChange={setValue} mentions={mentions} />;
  }

  const boldNames = (): string[] =>
    [...screen.getByTestId("editor-highlight").querySelectorAll("strong")].map(
      (element) => element.textContent ?? "",
    );

  it("bolds participant and actor names in the highlight layer", () => {
    render(
      <MentionsHarness
        initial={"actor User\nparticipant API\nUser -> API: Login\n"}
      />,
    );
    expect(boldNames()).toEqual(["User", "API", "User", "API"]);
    // The layer reproduces the source exactly, so the bold glyphs sit on top of
    // the transparent textarea's own.
    expect(screen.getByTestId("editor-highlight").textContent).toBe(
      "actor User\nparticipant API\nUser -> API: Login\n",
    );
  });

  it("renames usages as the declaration's name is retyped", () => {
    render(<MentionsHarness initial={"participant API\nAPI -> DB: hi\n"} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: { value: "participant APIX\nAPI -> DB: hi\n" },
    });

    expect(textarea.value).toBe("participant APIX\nAPIX -> DB: hi\n");
    expect(boldNames()).toEqual(["APIX", "APIX", "DB"]);
  });

  it("does not rewrite the document when a message endpoint is edited", () => {
    render(<MentionsHarness initial={"participant API\nAPI -> DB: hi\n"} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: { value: "participant API\nSVC -> DB: hi\n" },
    });

    expect(textarea.value).toBe("participant API\nSVC -> DB: hi\n");
  });
});
