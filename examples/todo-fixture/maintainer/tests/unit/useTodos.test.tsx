import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTodos } from "@fixture/hooks/useTodos";
import { loadTodos } from "@fixture/utils/storage";

describe("add-todo", () => {
  it("adds non-empty todos", () => {
    const { result } = renderHook(() => useTodos());

    act(() => {
      result.current.setDraft("Buy milk");
      result.current.addTodo("Buy milk");
    });

    expect(result.current.todos).toHaveLength(1);
    expect(result.current.todos[0]?.text).toBe("Buy milk");
    expect(result.current.draft).toBe("");
  });

  it("rejects empty and whitespace-only input", () => {
    const { result } = renderHook(() => useTodos());

    act(() => {
      result.current.setDraft("   ");
      result.current.addTodo("   ");
    });

    expect(result.current.todos).toHaveLength(0);
    expect(result.current.draft).toBe("   ");

    act(() => {
      result.current.setDraft("");
      result.current.addTodo("");
    });

    expect(result.current.todos).toHaveLength(0);
    expect(result.current.draft).toBe("");
  });
});

describe("filter-tabs", () => {
  it("filters active and completed todos", () => {
    const { result } = renderHook(() => useTodos());

    act(() => {
      result.current.addTodo("Active one");
      result.current.addTodo("Done one");
    });

    const doneId = result.current.todos.find((t) => t.text === "Done one")?.id;
    expect(doneId).toBeDefined();

    act(() => {
      result.current.toggleTodo(doneId!);
      result.current.setFilter("active");
    });

    expect(result.current.visibleTodos.every((t) => !t.completed)).toBe(true);

    act(() => {
      result.current.setFilter("completed");
    });

    expect(result.current.visibleTodos.every((t) => t.completed)).toBe(true);
  });
});

describe("toggle-persist", () => {
  it("persists completion after reload", () => {
    const { result } = renderHook(() => useTodos());

    act(() => {
      result.current.addTodo("Persist me");
    });

    const id = result.current.todos[0]!.id;

    act(() => {
      result.current.toggleTodo(id);
    });

    const stored = loadTodos();
    expect(stored.find((t) => t.id === id)?.completed).toBe(true);
  });
});

describe("clear-completed", () => {
  it("removes only completed todos", () => {
    const { result } = renderHook(() => useTodos());

    act(() => {
      result.current.addTodo("Keep");
      result.current.addTodo("Remove");
    });

    const removeId = result.current.todos.find((t) => t.text === "Remove")?.id;
    act(() => {
      result.current.toggleTodo(removeId!);
      result.current.clearCompleted();
    });

    expect(result.current.todos).toHaveLength(1);
    expect(result.current.todos[0]?.text).toBe("Keep");
  });
});
