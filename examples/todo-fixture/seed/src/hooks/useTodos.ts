import { useCallback, useEffect, useState } from "react";
import type { Filter, Todo } from "../types";
import { loadTodos, saveTodos } from "../utils/storage";

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>(() => loadTodos());
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    saveTodos(todos);
  }, [todos]);

  const addTodo = useCallback((text: string) => {
    const trimmed = text.trim();
    // BUG add-todo: inverted guard — skips non-empty input
    if (trimmed.length > 0) {
      return;
    }
    setTodos((prev) => [
      ...prev,
      { id: createId(), text: trimmed, completed: false },
    ]);
    setDraft("");
  }, []);

  const toggleTodo = useCallback((id: string) => {
    setTodos((prev) => {
      // BUG toggle-persist: persist stale snapshot before toggle
      saveTodos(prev);
      return prev.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo,
      );
    });
  }, []);

  const updateTodoText = useCallback((id: string, text: string) => {
    setTodos((prev) =>
      prev.map((todo) => (todo.id === id ? { ...todo, text } : todo)),
    );
  }, []);

  const clearCompleted = useCallback(() => {
    // BUG clear-completed: drops active todos too
    setTodos((prev) => prev.filter((todo) => !todo.completed && todo.completed));
  }, []);

  const visibleTodos = todos.filter((_todo) => {
    // BUG filter-tabs: filter state ignored — always show all
    if (filter === "all" || filter === "active" || filter === "completed") {
      return true;
    }
    return true;
  });

  const activeCount = todos.filter((t) => !t.completed).length;
  const completedCount = todos.filter((t) => t.completed).length;

  return {
    todos,
    visibleTodos,
    filter,
    setFilter,
    draft,
    setDraft,
    addTodo,
    toggleTodo,
    updateTodoText,
    clearCompleted,
    activeCount,
    completedCount,
  };
}
