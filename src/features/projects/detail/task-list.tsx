import { Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { api, errorMessage, type Task } from "@/lib/tauri"
import { cn } from "@/lib/utils"

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; tasks: Task[] }

export function TaskList({ projectId, className }: { projectId: string; className?: string }) {
  const [state, setState] = useState<State>({ status: "loading" })
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setState({ status: "ready", tasks: await api.getTasks(projectId) })
    } catch (e) {
      setState({ status: "error", message: errorMessage(e) })
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  /** Run a backend operation that returns the full updated list. */
  async function run(op: () => Promise<Task[]>): Promise<boolean> {
    setBusy(true)
    try {
      setState({ status: "ready", tasks: await op() })
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    if (await run(() => api.addTask(projectId, title))) setTitle("")
  }

  const tasks = state.status === "ready" ? state.tasks : []
  const done = tasks.filter((t) => t.done).length

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>To-do</CardTitle>
        <CardDescription>
          {state.status === "ready" && tasks.length > 0 ? `${done} of ${tasks.length} done` : "Tasks for this project"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={onAdd} className="flex gap-2">
          <Input
            aria-label="New task"
            placeholder="Add a task"
            autoComplete="off"
            maxLength={200}
            value={title}
            disabled={state.status !== "ready"}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button type="submit" size="icon" aria-label="Add task" disabled={busy || !title.trim()}>
            <Plus />
          </Button>
        </form>

        {state.status === "loading" && <Skeleton className="h-20" />}
        {state.status === "error" && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {state.status === "ready" && tasks.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">No tasks. Either you’re ahead of schedule or you forgot something.</p>
        )}
        {state.status === "ready" && tasks.length > 0 && (
          <ul className="flex flex-col gap-1">
            {tasks.map((t) => (
              <li key={t.id} className="group flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-muted/50">
                <Checkbox
                  id={`task-${t.id}`}
                  checked={t.done}
                  disabled={busy}
                  aria-label={t.title}
                  onCheckedChange={(checked) => void run(() => api.setTaskDone(projectId, t.id, checked === true))}
                />
                <label
                  htmlFor={`task-${t.id}`}
                  className={cn("flex-1 text-sm break-words", t.done && "text-muted-foreground line-through")}
                >
                  {t.title}
                </label>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete task ${t.title}`}
                  className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  disabled={busy}
                  onClick={() => void run(() => api.deleteTask(projectId, t.id))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
