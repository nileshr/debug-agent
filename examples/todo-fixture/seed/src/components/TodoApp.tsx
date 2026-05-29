import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { Todo } from "../types";

interface TodoItemProps {
  todo: Todo;
  onToggle: (id: string) => void;
  onUpdateText: (id: string, text: string) => void;
}

function TodoItem({ todo, onToggle, onUpdateText }: TodoItemProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);

  const commitEdit = () => {
    const trimmed = editText.trim();
    if (trimmed) {
      onUpdateText(todo.id, trimmed);
    }
    setEditing(false);
  };

  const handleBlur = () => {
    // BUG inline-edit: blur restores original label instead of saving
    setEditText(todo.text);
    setEditing(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commitEdit();
    }
    if (event.key === "Escape") {
      setEditText(todo.text);
      setEditing(false);
    }
  };

  return (
    <li className={`todo-item${todo.completed ? " completed" : ""}`} data-testid="todo-item">
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() => onToggle(todo.id)}
        aria-label={`Toggle ${todo.text}`}
        data-testid="todo-toggle"
      />
      {editing ? (
        <input
          className="todo-edit"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          data-testid="todo-edit-input"
        />
      ) : (
        <span
          className="todo-label"
          onDoubleClick={() => {
            setEditText(todo.text);
            setEditing(true);
          }}
          data-testid="todo-label"
        >
          {todo.text}
        </span>
      )}
    </li>
  );
}

interface TodoAppProps {
  todos: Todo[];
  visibleTodos: Todo[];
  filter: "all" | "active" | "completed";
  setFilter: (filter: "all" | "active" | "completed") => void;
  draft: string;
  setDraft: (value: string) => void;
  addTodo: (text: string) => void;
  toggleTodo: (id: string) => void;
  updateTodoText: (id: string, text: string) => void;
  clearCompleted: () => void;
  activeCount: number;
  completedCount: number;
}

export function TodoApp({
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
}: TodoAppProps) {
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    addTodo(draft);
  };

  return (
    <div className="todo-app" data-testid="todo-app">
      <header>
        <h1>Todos</h1>
        <form onSubmit={handleSubmit} data-testid="todo-form">
          <input
            type="text"
            placeholder="What needs to be done?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="New todo"
            data-testid="todo-input"
          />
          <button type="submit" data-testid="todo-add">
            Add
          </button>
        </form>
      </header>

      <ul className="todo-list" data-testid="todo-list">
        {visibleTodos.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggle={toggleTodo}
            onUpdateText={updateTodoText}
          />
        ))}
      </ul>

      <footer className="todo-footer">
        <span data-testid="todo-count">{activeCount} active</span>
        <nav className="filters" aria-label="Filter todos">
          {(["all", "active", "completed"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
              data-testid={`filter-${value}`}
            >
              {value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </nav>
        {completedCount > 0 ? (
          <button type="button" onClick={clearCompleted} data-testid="clear-completed">
            Clear completed
          </button>
        ) : null}
      </footer>
    </div>
  );
}
