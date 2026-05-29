import { useTodos } from "./hooks/useTodos";
import { TodoApp } from "./components/TodoApp";

export default function App() {
  const todoState = useTodos();
  return <TodoApp {...todoState} />;
}
