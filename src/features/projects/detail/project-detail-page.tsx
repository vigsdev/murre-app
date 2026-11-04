import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { FolderSearch, PackageOpen, TriangleAlert } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, errorMessage, type ProjectRecord } from "@/lib/tauri"
import { locateProjectFolder } from "@/features/sync/locate-folder"
import { useProjectsChanged, useSync } from "@/features/sync/sync-context"
import { SyncProblems } from "@/features/sync/sync-problems"
import { useProjectWatch } from "@/features/sync/use-project-watch"
import { SettingsTab } from "./settings-tab"
import { CompanionControl } from "@/features/companion/companion-control"
import { OpenInAfterEffects, useOpenInAfterEffects } from "../open-in-ae"
import { STATUS_TONE } from "../constants"
import { formatDeadline, priorityLabel, statusLabel } from "../project-utils"
import { EditableTitle, ProjectHead, type HeadPatch } from "./project-head"
import { PROJECTS_CHANGED } from "@/features/sync/sync-context"
import { recordGreetingEvent } from "@/features/home/greetings/events"
import { cn } from "@/lib/utils"
import { AssetsTab } from "./assets-tab"
import { ColorsTab } from "./colors-tab"
import { ExpressionsTab } from "./expressions-tab"
import { FontsTab } from "./fonts-tab"
import { NotesTab } from "./notes-tab"
import { PackageDialog } from "./package-dialog"
import { ProjectTab } from "./project-tab"
import { RendersTab } from "./renders-tab"

// The board is loaded only when the References tab is first opened.
const ReferencesTab = lazy(() => import("./references-tab").then((m) => ({ default: m.ReferencesTab })))

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; project: ProjectRecord }

/** Tabs from the product spec. "Project", "Assets", "Renders", "Notes", "References", "Colors", "Expressions", "Fonts" and "Settings" are built so far. */
const TABS = [
  { value: "project", label: "Project" },
  { value: "assets", label: "Assets" },
  { value: "renders", label: "Renders" },
  { value: "notes", label: "Notes" },
  { value: "references", label: "References" },
  { value: "colors", label: "Colors" },
  { value: "expressions", label: "Expressions" },
  { value: "fonts", label: "Fonts" },
  { value: "settings", label: "Settings" },
] as const

export function ProjectDetailPage() {
  const { id = "" } = useParams()
  const [state, setState] = useState<State>({ status: "loading" })
  const stateRef = useRef(state)
  stateRef.current = state
  const openAe = useOpenInAfterEffects(id)
  // Bumped when files change on disk, so tabs re-read their data in place.
  const [tokens, setTokens] = useState({ colors: 0, expressions: 0, fonts: 0, environment: 0, comps: 0, footage: 0, files: 0 })
  const { rescan } = useSync()
  const [packaging, setPackaging] = useState(false)

  useEffect(() => {
    let cancelled = false
    setState({ status: "loading" })
    api
      .getProject(id)
      .then((project) => !cancelled && setState({ status: "ready", project }))
      .catch((e) => !cancelled && setState({ status: "error", message: errorMessage(e) }))
    return () => {
      cancelled = true
    }
  }, [id])

  const project = state.status === "ready" ? state.project : null

  // Remember that this project was just opened, for Home's list of recent projects.
  const openedId = project?.id
  useEffect(() => {
    if (openedId) void api.markProjectOpened(openedId).catch(() => {})
  }, [openedId])

  // Re-read the project record (e.g. its folder became available again) without a loading flash.
  const refreshRecord = useCallback(() => {
    api
      .getProject(id)
      .then((p) => setState({ status: "ready", project: p }))
      .catch(() => {})
  }, [id])
  useProjectsChanged(refreshRecord)

  /**
   * Saves a change made in the header. The page shows it at once; if saving fails it goes back and a toast says why.
   * A toast with Undo puts the old value back. The tabs, the sidebar and the other pages hear about it through
   * PROJECTS_CHANGED.
   */
  const change = useCallback(
    async (patch: HeadPatch, undo = false): Promise<void> => {
      // Read through a ref, so an Undo from an earlier toast changes only its own field.
      const current = stateRef.current
      if (current.status !== "ready") return
      const before = current.project
      const next = { ...before, ...patch }
      stateRef.current = { status: "ready", project: next }
      setState(stateRef.current)
      try {
        const saved = await api.updateProject({
          id: next.id,
          name: next.name,
          client: next.client,
          deadline: next.deadline,
          priority: next.priority,
          description: next.description,
          status: next.status,
        })
        setState({ status: "ready", project: saved })
        window.dispatchEvent(new Event(PROJECTS_CHANGED))
        if (patch.status === "completed" && before.status !== "completed") recordGreetingEvent("completed", saved.name)
        if (!undo) {
          const old: HeadPatch = {}
          for (const k of Object.keys(patch) as (keyof HeadPatch)[]) (old as Record<string, unknown>)[k] = before[k]
          toast(changeMessage(patch, saved), { action: { label: "Undo", onClick: () => void change(old, true) } })
        }
      } catch (e) {
        setState({ status: "ready", project: before })
        toast.error(errorMessage(e))
      }
    },
    [],
  )

  useProjectWatch(project?.available ? project.id : null, (change) => {
    setTokens((t) => ({
      colors: t.colors + (change.metadata.includes("colors.json") ? 1 : 0),
      expressions: t.expressions + (change.metadata.includes("expressions.json") ? 1 : 0),
      fonts: t.fonts + (change.metadata.includes("fonts.json") ? 1 : 0),
      environment: t.environment + (change.metadata.includes("environment.json") ? 1 : 0),
      comps: t.comps + (change.metadata.includes("comps.json") ? 1 : 0),
      footage: t.footage + (change.metadata.includes("assets.json") ? 1 : 0),
      files: t.files + (change.files ? 1 : 0),
    }))
    // The folder itself moved or vanished: let the app re-check its projects.
    if (change.rootChanged) void rescan().then(refreshRecord)
  })

  return (
    <div className="relative flex min-h-full flex-none flex-col overflow-hidden rounded-[inherit]">
      {/* A soft colour that fades out down the page, behind everything. It follows the project's status. */}
      {project && (
        <div
          aria-hidden
          className={cn("pointer-events-none absolute inset-x-0 top-0 h-96 bg-gradient-to-b to-transparent", STATUS_TONE[project.status].glow)}
        />
      )}
      <PageHeader
        hero
        title={project?.name ?? "Project"}
        titleNode={project && <EditableTitle name={project.name} onSave={(name) => void change({ name })} />}
        actions={
          project?.available && (
            <>
              <OpenInAfterEffects controller={openAe} variant="default" />
              <Button variant="outline" size="sm" aria-label="Package for delivery" title="Package for delivery" onClick={() => setPackaging(true)}>
                <PackageOpen /> <span className="hidden xl:inline">Package</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label="Show in Finder"
                title="Show in Finder"
                onClick={() => void revealItemInDir(project.path).catch((e) => toast.error(errorMessage(e)))}
              >
                <FolderSearch /> <span className="hidden xl:inline">Show in Finder</span>
              </Button>
            </>
          )
        }
      />
      <div className="relative flex flex-1 flex-col gap-6 px-6 pb-6 pt-1">
        {project && <ProjectHead project={project} onChange={(patch) => void change(patch)} />}
        {state.status === "loading" && <Skeleton className="h-64" />}

        {state.status === "error" && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Could not open this project</EmptyTitle>
              <EmptyDescription role="alert">{state.message}</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" render={<Link to="/projects" />}>
              Back to projects
            </Button>
          </Empty>
        )}

        {project?.available && <PackageDialog projectId={project.id} projectName={project.name} open={packaging} onOpenChange={setPackaging} />}

        {project && <SyncProblems projectId={project.id} />}

        {project && !project.available && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlert />
              </EmptyMedia>
              <EmptyTitle>Project folder not found</EmptyTitle>
              <EmptyDescription>
                {project.path} could not be found. If it is on an external drive, reconnect it. If the folder was moved,
                use Locate folder to point Murre at its new location.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              variant="outline"
              onClick={() =>
                void locateProjectFolder(project).then((u) => {
                  if (u) void rescan().then(refreshRecord)
                })
              }
            >
              Locate folder…
            </Button>
          </Empty>
        )}

        {project?.available && (
          <Tabs defaultValue="project" className="flex-1">
            <div className="flex items-end justify-between gap-x-4 border-b pb-0.5">
              <TabsList variant="line" className="h-auto shrink-0 flex-nowrap">
                {TABS.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="mb-1.5 min-w-0 shrink">
                <CompanionControl projectId={project.id} projectName={project.name} hideIdleLabel />
              </div>
            </div>
            <TabsContent value="project" className="pt-5 not-[[hidden]]:flex not-[[hidden]]:flex-col">
              <ProjectTab project={project} reloadToken={tokens.files} needsToken={tokens.fonts + tokens.environment} openAe={openAe} />
            </TabsContent>
            <TabsContent value="assets" className="pt-5">
              <AssetsTab project={project} reloadToken={tokens.files} footageToken={tokens.footage} />
            </TabsContent>
            <TabsContent value="renders" className="pt-5">
              <RendersTab project={project} reloadToken={tokens.files} compsToken={tokens.comps} />
            </TabsContent>
            <TabsContent value="references" className="pt-5">
              <Suspense fallback={<Skeleton className="h-96" />}>
                <ReferencesTab projectId={project.id} />
              </Suspense>
            </TabsContent>
            <TabsContent value="notes" className="pt-5">
              <NotesTab projectId={project.id} />
            </TabsContent>
            <TabsContent value="colors" className="pt-5">
              <ColorsTab projectId={project.id} reloadToken={tokens.colors} />
            </TabsContent>
            <TabsContent value="expressions" className="pt-5">
              <ExpressionsTab projectId={project.id} reloadToken={tokens.expressions} />
            </TabsContent>
            <TabsContent value="fonts" className="pt-5">
              <FontsTab projectId={project.id} reloadToken={tokens.fonts} />
            </TabsContent>
            <TabsContent value="settings" className="pt-5">
              <SettingsTab projectId={project.id} />
            </TabsContent>
            {TABS.filter((t) => !["project", "assets", "renders", "notes", "references", "colors", "expressions", "fonts", "settings"].includes(t.value)).map((t) => (
              <TabsContent key={t.value} value={t.value} className="pt-5">
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyTitle>{t.label}</EmptyTitle>
                    <EmptyDescription>This tab is not built yet.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>
    </div>
  )
}

function changeMessage(patch: HeadPatch, p: ProjectRecord): string {
  if (patch.name !== undefined) return `Renamed to “${p.name}”`
  if (patch.client !== undefined) return p.client ? `Client set to ${p.client}` : "Client removed"
  if (patch.status !== undefined) return `Status set to ${statusLabel(p.status)}`
  if (patch.priority !== undefined) return `Priority set to ${priorityLabel(p.priority).toLowerCase()}`
  return p.deadline ? `Deadline set to ${formatDeadline(p.deadline)}` : "Deadline cleared"
}
