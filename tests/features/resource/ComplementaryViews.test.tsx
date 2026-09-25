import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ComplementaryViews from "../../../src/features/resource/ComplementaryViews";

describe("ComplementaryViews", () => {
  it("renders typed navigation with the related resource role", () => {
    const onNavigate = vi.fn();
    render(
      <ComplementaryViews
        resourceId="sequence-1"
        relationships={[{
          kind: "complementary-view",
          sourceId: "sequence-1",
          targetId: "flow-1",
          sourceRole: "execution",
          targetRole: "causal",
        }]}
        resources={[{ id: "flow-1", title: "Causal flow" }]}
        onNavigate={onNavigate}
      />,
    );

    const link = screen.getByRole("button", {
      name: "Complementary view · causal → Causal flow",
    });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("flow-1");
  });
});
