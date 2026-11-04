import type { ProjectRecord } from "@/lib/tauri"
import type { useOpenInAfterEffects } from "../open-in-ae"
import { NeedsCard } from "./needs-card"
import { PremiereCard } from "./premiere-card"
import { TaskList } from "./task-list"
import { WorkfileTimeline } from "./workfile-timeline"

export function ProjectTab({
  project,
  reloadToken = 0,
  needsToken = 0,
  openAe,
}: {
  project: ProjectRecord
  reloadToken?: number
  needsToken?: number
  openAe: ReturnType<typeof useOpenInAfterEffects>
}) {
  return (
    <div className="grid flex-1 items-stretch gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {/* The After Effects card fills the column; a Premiere card, when there is one, sits under it. */}
      <div className="flex flex-col gap-4 [&>*:first-child]:flex-1">
        <WorkfileTimeline projectId={project.id} reloadToken={reloadToken} onOpen={(path) => void openAe.open(path)} />
        <NeedsCard projectId={project.id} reloadToken={needsToken} />
        <PremiereCard projectId={project.id} reloadToken={reloadToken} />
      </div>
      <TaskList projectId={project.id} className="h-full" />
    </div>
  )
}
