# Todo Fixture Glossary

| Term | Location | Role |
|------|----------|------|
| **Seed** | `examples/todo-fixture/seed/` | Committed broken todo app copied on reset |
| **Workdir** | `.tmp/todo-fixture-workdir/` | Disposable target repo for `debug` runs |
| **Bug manifest** | `examples/todo-fixture/bugs.json` | Ordered symptom text passed to `--bug` |
| **Maintainer oracle** | `examples/todo-fixture/maintainer/` | Expected behavior + acceptance tests (hidden from debug session) |
| **Harness** | `scripts/todo-fixture.mjs` | reset / serve / run / accept orchestration |
