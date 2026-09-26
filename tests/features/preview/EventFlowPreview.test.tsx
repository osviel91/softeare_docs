import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EventFlowPreview from "../../../src/features/preview/EventFlowPreview";

describe("EventFlowPreview semantic event selection", () => {
  it("selects a bound event when its visible label is clicked", () => {
    const select = vi.fn();
    render(
      <EventFlowPreview
        source={'event OrderCreated messageRef msg-created\n'}
        onSemanticMessageSelect={select}
      />,
    );

    fireEvent.click(screen.getByText("OrderCreated"));

    expect(select).toHaveBeenCalledWith("msg-created", expect.any(String));
  });
});
