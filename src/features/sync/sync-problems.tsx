import { TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useSync } from "./sync-context"

/** Warns about projects whose folder no longer matches what Murre has on record. */
export function SyncProblems({ projectId }: { projectId?: string }) {
  const { report } = useSync()
  const problems = (report?.problems ?? []).filter((p) => !projectId || p.id === projectId)
  if (problems.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-testid="sync-problems">
      {problems.map((p) => (
        <Alert key={p.id} variant="destructive">
          <TriangleAlert />
          <AlertTitle>{p.kind === "replaced" ? `“${p.name}” points at a different project` : `“${p.name}” needs attention`}</AlertTitle>
          <AlertDescription>{p.message}</AlertDescription>
        </Alert>
      ))}
    </div>
  )
}
