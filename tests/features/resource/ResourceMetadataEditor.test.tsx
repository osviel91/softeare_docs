import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ResourceMetadataEditor from "../../../src/features/resource/ResourceMetadataEditor";

describe("ResourceMetadataEditor", () => {
  it("renders context and supports clearing, editing, and normalized save", async () => {
    const onSave = vi.fn(async () => ({
      description: "Updated",
      tags: ["team"],
    }));
    render(
      <ResourceMetadataEditor
        metadata={{ description: "Existing", tags: ["api", "docs"] }}
        writable
        onSave={onSave}
      />,
    );

    expect(screen.getByText("Existing")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit resource context" }),
    );
    fireEvent.change(screen.getByLabelText("Resource description"), {
      target: { value: " Updated " },
    });
    fireEvent.change(screen.getByLabelText("Resource tags"), {
      target: { value: " api, API, team " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save context" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        description: " Updated ",
        tags: [" api", " API", " team "],
      }),
    );
  });

  it("does not show an edit affordance when read-only and surfaces conflicts", async () => {
    const onSave = vi.fn(async () => new Error("Revision conflict"));
    const { rerender } = render(
      <ResourceMetadataEditor metadata={{}} writable={false} onSave={onSave} />,
    );
    expect(
      screen.queryByRole("button", { name: "Add resource context" }),
    ).toBeNull();

    rerender(<ResourceMetadataEditor metadata={{}} writable onSave={onSave} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add resource context" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save context" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Revision conflict",
    );
  });
});
