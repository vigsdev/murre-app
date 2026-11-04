import { open } from "@tauri-apps/plugin-dialog"
import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { AddFromAeButton } from "./add-from-ae"
import { FolderInput, FolderKanban, Plus, SearchX } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useSpaces } from "@/features/spaces/spaces-context"
import { api, errorMessage, type ImportOutcome, type ProjectRecord } from "@/lib/tauri"
import { SyncProblems } from "@/features/sync/sync-problems"
import { locateProjectFolder } from "@/features/sync/locate-folder"
import { useProjectsChanged, useSync } from "@/features/sync/sync-context"
import { EditProjectDialog } from "./edit-project-dialog"
import { AnimatePresence, motion } from "motion/react"
import { listItem } from "@/lib/motion"
import { ProjectCard } from "./project-card"
import { ProjectsToolbar } from "./projects-toolbar"
import {
  applyQuery,
  DEFAULT_QUERY,
  isDefaultQuery,
  type ListQuery,
} from "./project-utils"

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; projects: ProjectRecord[] }

/** All projects, or (with `spaceId`) just the projects filed in one Space. */
export function ProjectsPage({ spaceId }: { spaceId?: string }) {
  const { spaces, loaded: spacesLoaded } = useSpaces()
  const space = spaceId ? spaces.find((x) => x.id === spaceId) : undefined
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [query, setQuery] = useState<ListQuery>(DEFAULT_QUERY)
  const [editing, setEditing] = useState<ProjectRecord | null>(null)
  const [removing, setRemoving] = useState<ProjectRecord | null>(null)
  const [pendingImport, setPendingImport] = useState<{ path: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setLoad({ status: "ready", projects: await api.listProjects() })
    } catch (e) {
      setLoad({ status: "error", message: errorMessage(e) })
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])
  useProjectsChanged(() => void reload())
  const { rescan } = useSync()

  const visible = useMemo(
    () => (load.status === "ready" ? applyQuery(spaceId ? load.projects.filter((p) => p.spaceId === spaceId) : load.projects, query) : []),
    [load, query, spaceId],
  )

  /** Archiving forgets the earlier status, so an unarchived project goes back to Completed. */
  async function unarchive(p: ProjectRecord) {
    try {
      await api.updateProject({
        id: p.id,
        name: p.name,
        client: p.client,
        deadline: p.deadline,
        priority: p.priority,
        description: p.description,
        status: "completed",
      })
      await reload()
      toast.success(`Moved “${p.name}” back to Completed`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  async function archive(p: ProjectRecord) {
    const input = {
      id: p.id,
      name: p.name,
      client: p.client,
      deadline: p.deadline,
      priority: p.priority,
      description: p.description,
    }
    try {
      await api.updateProject({ ...input, status: "archived" })
      await reload()
      toast.success(`“${p.name}” archived. Out of sight, not gone.`, {
        action: {
          label: "Undo",
          onClick: () =>
            void api
              .updateProject({ ...input, status: p.status })
              .then(reload)
              .catch((e) => toast.error(errorMessage(e))),
        },
      })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  async function confirmRemove() {
    if (!removing) return
    setBusy(true)
    try {
      await api.removeProject(removing.id)
      toast.success(`Removed “${removing.name}” from Murre`, {
        description: "Its folder and files were not touched. You can import it again later.",
      })
      setRemoving(null)
      await reload()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function reportImport(name: string, outcome: ImportOutcome) {
    if (outcome === "relinked") toast.success(`Found “${name}” at its new location`)
    else if (outcome === "metadata_created")
      toast.success(`Added “${name}”`, { description: "A hidden .murre folder was created inside it. Nothing else changed." })
    else toast.success(`Imported “${name}”`)
  }

  async function startImport() {
    try {
      const picked = await open({ directory: true, multiple: false, title: "Choose a project folder to import" })
      if (typeof picked !== "string") return
      const info = await api.inspectImport(picked)
      if (info.alreadyImported) {
        toast.info(`“${info.name}” is already in Murre`)
      } else if (info.hasMetadata) {
        const result = await api.importProject(picked, false)
        reportImport(result.record.name, result.outcome)
        await reload()
      } else {
        setPendingImport({ path: picked, name: info.name })
      }
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  async function confirmImport() {
    if (!pendingImport) return
    setBusy(true)
    try {
      const result = await api.importProject(pendingImport.path, true)
      reportImport(result.record.name, result.outcome)
      setPendingImport(null)
      await reload()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title={spaceId ? (space?.name ?? "Space") : "Projects"}
        start={
          <>
            <Button size="sm" onClick={() => void startImport()}>
              <FolderInput /> Import project
            </Button>
            <AddFromAeButton />
          </>
        }
        end={load.status === "ready" && load.projects.length > 0 ? <ProjectsToolbar query={query} onChange={setQuery} /> : null}
      />
      <div className="flex flex-1 flex-col gap-4 p-6">
        <SyncProblems />
        {load.status === "loading" && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] items-start gap-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-52" />
            ))}
          </div>
        )}

        {load.status === "error" && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Having trouble loading projects. Try again.</EmptyTitle>
              <EmptyDescription role="alert">{load.message}</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          </Empty>
        )}

        {spaceId && spacesLoaded && !space && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>This Space no longer exists</EmptyTitle>
              <EmptyDescription>That Space may be gone, but your projects are still under Projects.</EmptyDescription>
            </EmptyHeader>
            <Button render={<Link to="/projects" />}>Go to Projects</Button>
          </Empty>
        )}

        {(!spaceId || space) && load.status === "ready" && load.projects.length === 0 && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderKanban />
              </EmptyMedia>
              <EmptyTitle>No projects yet. A beautifully clean slate.</EmptyTitle>
              <EmptyDescription>Create a new project, or import a folder you already work in.</EmptyDescription>
            </EmptyHeader>
            <div className="flex gap-2">
              <Button render={<Link to={spaceId ? `/projects/new?space=${spaceId}` : "/projects/new"} />}>
                <Plus /> New project
              </Button>
              <Button variant="outline" onClick={() => void startImport()}>
                <FolderInput /> Import project
              </Button>
            </div>
          </Empty>
        )}

        {(!spaceId || space) && load.status === "ready" && load.projects.length > 0 && (
          <>
            {spaceId && load.projects.every((p) => p.spaceId !== spaceId) ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderKanban />
                  </EmptyMedia>
                  <EmptyTitle>Nothing in this Space yet. Room to make a mess.</EmptyTitle>
                  <EmptyDescription>Create a project here, or open a project's menu, choose Edit and pick this Space.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : visible.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchX />
                  </EmptyMedia>
                  <EmptyTitle>No projects match. The filters might be a little too ambitious.</EmptyTitle>
                  <EmptyDescription>Nothing matches those filters. Try loosening them up.</EmptyDescription>
                </EmptyHeader>
                {!isDefaultQuery(query) && (
                  <Button variant="outline" onClick={() => setQuery({ ...DEFAULT_QUERY, sort: query.sort })}>
                    Clear filters
                  </Button>
                )}
              </Empty>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] items-start gap-4">
                <AnimatePresence initial={false}>
                {visible.map((p) => (
                  <motion.div key={p.id} {...listItem}>
                  <ProjectCard
                    project={p}
                    spaceName={spaceId ? undefined : spaces.find((x) => x.id === p.spaceId)?.name}
                    onEdit={setEditing}
                    onArchive={(x) => void archive(x)}
                    onUnarchive={(x) => void unarchive(x)}
                    onRemove={setRemoving}
                    onLocate={(x) =>
                      void locateProjectFolder(x).then((u) => {
                        if (u) void rescan().then(reload)
                      })
                    }
                    onReveal={(x) => void revealItemInDir(x.path).catch((e) => toast.error(errorMessage(e)))}
                  />
                  </motion.div>
                ))}
                </AnimatePresence>
              </div>
            )}
          </>
        )}
      </div>

      <EditProjectDialog
        project={editing}
        onClose={() => setEditing(null)}
        onSaved={(p) => {
          setEditing(null)
          toast.success(`Saved “${p.name}”`)
          void reload()
        }}
      />

      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && !busy && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.name}” from Murre?</AlertDialogTitle>
            <AlertDialogDescription>
              The project's folder and all its files stay exactly where they are. Only the entry in Murre is removed,
              and you can import the folder again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void confirmRemove()}>
              Remove from Murre
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingImport !== null} onOpenChange={(o) => !o && !busy && setPendingImport(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add “{pendingImport?.name}” to Murre?</AlertDialogTitle>
            <AlertDialogDescription>
              This folder isn't a Murre project yet. Murre will add a hidden <code>.murre</code> folder inside it
              for notes and metadata. Your existing files and folders are not moved, renamed or changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void confirmImport()}>
              Add project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
