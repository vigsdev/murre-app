/**
 * Murre To-do: the open project's to-do list inside After Effects. It reads and writes the same `.murre/tasks.json` the
 * Murre app uses (see lib/murre/tasks.ts), so it works with the app open or closed, and a tick on one side shows on the
 * other within a couple of seconds.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Checkbox, MantineProvider, Text, TextInput } from "@mantine/core";
import "@mantine/core/styles.css";
import { shadcnCssVariableResolver } from "../main/cssVariablesResolver";
import { panelTheme } from "../main/panel-theme";
import "../main/style.css";
import "./todo.scss";
import { csi, evalFile, evalTS } from "../lib/utils/bolt";
import { cepIo } from "../lib/murre/io";
import { addTask, deleteTask, placeFor, readTasks, setDone, type Task, type TaskPlace } from "../lib/murre/tasks";

// The After Effects side, without the main panel's menus (initBolt would add them here too).
if (window.cep) {
  try {
    evalFile(`${csi.getSystemPath("extension")}/jsx/index.js`);
  } catch {
    /* shown as "Could not talk to After Effects" below */
  }
}

/** How often the panel looks for a different open project and for changes made in the app. */
const POLL_MS = 2000;

type View =
  | { kind: "loading" }
  | { kind: "outside" }
  | { kind: "none" }
  | { kind: "unsaved" }
  | { kind: "error"; message: string }
  | { kind: "ready"; place: TaskPlace; tasks: Task[] };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useTodo() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const last = useRef("");
  const show = useCallback((next: View) => {
    // Re-render only when something changed, so typing and hovering aren't disturbed every two seconds.
    const key = JSON.stringify(next);
    if (key === last.current) return;
    last.current = key;
    setView(next);
  }, []);

  const refresh = useCallback(async () => {
    if (typeof window.cep === "undefined") return show({ kind: "outside" });
    try {
      const info = await evalTS("getAepInfo");
      if (!info.saved || !info.path) return show(info.numItems > 0 ? { kind: "unsaved" } : { kind: "none" });
      const io = cepIo();
      const place = placeFor(io, info.path);
      show({ kind: "ready", place, tasks: readTasks(io, place.root) });
    } catch (e) {
      show({ kind: "error", message: messageOf(e) });
    }
  }, [show]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const t = window.setInterval(() => document.visibilityState === "visible" && void refresh(), POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(t);
    };
  }, [refresh]);

  /** Runs a change against the newest file and shows the result; a problem shows as a line under the list. */
  const [problem, setProblem] = useState<string | null>(null);
  const change = useCallback(
    (op: (place: TaskPlace) => Task[]) => {
      if (view.kind !== "ready") return false;
      try {
        const tasks = op(view.place);
        setProblem(null);
        show({ kind: "ready", place: view.place, tasks });
        return true;
      } catch (e) {
        setProblem(messageOf(e));
        return false;
      }
    },
    [view, show],
  );

  return { view, problem, change };
}

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

function TaskRow({ task, onToggle, onDelete }: { task: Task; onToggle: (done: boolean) => void; onDelete: () => void }) {
  return (
    <li className="row" data-done={task.done || undefined}>
      <Checkbox checked={task.done} onChange={(e) => onToggle(e.currentTarget.checked)} label={task.title} size="sm" classNames={{ label: "row-label" }} />
      <button type="button" className="row-delete" aria-label={`Delete “${task.title}”`} title="Delete" onClick={onDelete}>
        <CloseIcon />
      </button>
    </li>
  );
}

function Todo() {
  const { view, problem, change } = useTodo();
  const [title, setTitle] = useState("");

  if (view.kind !== "ready") {
    const text =
      view.kind === "loading" ? "Looking at the open project…"
      : view.kind === "outside" ? "Open this panel inside After Effects."
      : view.kind === "none" ? "Open a project to see its to-dos."
      : view.kind === "unsaved" ? "Save the project to keep a to-do list for it."
      : view.message;
    return (
      <div className="todo">
        <Text size="sm" c={view.kind === "error" ? "red.4" : "dimmed"} role="status">
          {text}
        </Text>
      </div>
    );
  }

  const { place, tasks } = view;
  const left = tasks.filter((t) => !t.done).length;
  return (
    <div className="todo">
      <header className="todo-head">
        <Text fw={500} truncate title={place.root}>
          {place.name}
        </Text>
        <Text size="xs" c="dimmed">
          {place.inMurre ? `${left} of ${tasks.length} left` : "Not in Murre · kept next to the file"}
        </Text>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (change((p) => addTask(cepIo(), p, title))) setTitle("");
        }}
      >
        <TextInput aria-label="New task" placeholder="Add a task" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={200} />
      </form>
      {tasks.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing to do yet.
        </Text>
      ) : (
        <ul className="rows">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              onToggle={(done) => change((p) => setDone(cepIo(), p, t.id, done))}
              onDelete={() => change((p) => deleteTask(cepIo(), p, t.id))}
            />
          ))}
        </ul>
      )}
      {problem && (
        <Text size="xs" c="red.4" role="alert">
          {problem}
        </Text>
      )}
    </div>
  );
}

document.body.style.backgroundColor = "#1e1e1e";

ReactDOM.createRoot(document.getElementById("app") as HTMLElement).render(
  <React.StrictMode>
    <MantineProvider theme={panelTheme} cssVariablesResolver={shadcnCssVariableResolver} forceColorScheme="dark">
      <Todo />
    </MantineProvider>
  </React.StrictMode>,
);
