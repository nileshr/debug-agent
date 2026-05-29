# Todo Fixture — Maintainer Oracle

This directory is **outside** the disposable workdir passed to `debug`. It records expected behavior and acceptance checks. Do not copy it into `.tmp/todo-fixture-workdir`.

## Glossary

| Term | Meaning |
|------|---------|
| **Seed** | Pristine broken app at `examples/todo-fixture/seed` |
| **Workdir** | Disposable copy at `.tmp/todo-fixture-workdir` |
| **Symptom** | Text passed to `debug --bug` (from `bugs.json`) |
| **Oracle** | Expected behavior documented here and enforced by tests |

## Expected behavior by bug

### `add-todo` (obvious)

- Submitting non-empty text via Add or Enter adds a todo to the list.
- Input clears after add.

### `filter-tabs` (obvious)

- **All** shows every todo.
- **Active** shows only incomplete todos.
- **Completed** shows only completed todos.

### `toggle-persist` (subtle)

- Toggling complete updates UI immediately.
- After reload, completion state matches what the user set.

### `inline-edit` (subtle)

- Double-click enters edit mode.
- Blur or Enter saves the edited text.
- Escape cancels and restores the previous label.

### `clear-completed` (subtle)

- Removes only completed todos.
- Active todos remain.

## Acceptance

Run from repo root:

```bash
npm run fixture:accept
```

Uses `FIXTURE_WORKDIR` (defaults to `.tmp/todo-fixture-workdir`). Tests **fail** on the broken baseline and **pass** when all bugs are fixed.
