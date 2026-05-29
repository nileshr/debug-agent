import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TodoApp } from "@fixture/components/TodoApp";
import { useTodos } from "@fixture/hooks/useTodos";

function Harness() {
  const props = useTodos();
  return <TodoApp {...props} />;
}

describe("inline-edit", () => {
  it("saves edited text on blur", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByTestId("todo-input"), "Edit me{Enter}");
    await user.dblClick(screen.getByTestId("todo-label"));
    const editInput = screen.getByTestId("todo-edit-input");
    await user.clear(editInput);
    await user.type(editInput, "Edited label");
    await user.tab();

    expect(screen.getByTestId("todo-label")).toHaveTextContent("Edited label");
  });
});
