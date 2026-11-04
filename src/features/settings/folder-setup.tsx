import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Folder, GripVertical, Lock, Plus, Trash2, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { api, errorMessage, type FolderKind, type FolderSpec } from "@/lib/tauri"
import { cn } from "@/lib/utils"

/** A folder as the editor holds it: the saved fields plus a stable id for dragging and React keys. */
interface Row extends FolderSpec {
  id: string
}

const newId = () => crypto.randomUUID()
const toRows = (folders: FolderSpec[]): Row[] => folders.map((f) => ({ ...f, id: newId() }))
const toSpecs = (rows: Row[]): FolderSpec[] => rows.map(({ name, kinds, extras }) => ({ name, kinds, extras }))
const keyOf = (rows: Row[]) => JSON.stringify(toSpecs(rows))

const PRESETS: { id: string; label: string; folders: FolderSpec[] }[] = [
  {
    id: "default",
    label: "Murre default",
    folders: [
      { name: "01 Images", kinds: ["image"], extras: [] },
      { name: "02 Audios", kinds: ["audio"], extras: [] },
      { name: "03 PSD Files", kinds: ["photoshop"], extras: [] },
      { name: "04 Illustrator Files", kinds: ["illustrator"], extras: [] },
      { name: "05 Templates", kinds: [], extras: [] },
      { name: "06 SoundFX", kinds: [], extras: [] },
      { name: "07 Videos", kinds: ["video"], extras: [] },
    ],
  },
  {
    id: "minimal",
    label: "Minimal",
    folders: [
      { name: "Footage", kinds: ["video"], extras: [] },
      { name: "Images", kinds: ["image", "photoshop", "illustrator"], extras: [] },
      { name: "Audio", kinds: ["audio"], extras: [] },
    ],
  },
  { id: "flat", label: "No sub-folders", folders: [] },
]

const FIXED_REST = ["03 Scripts & Storyboard", "04 Premiere & SFX", "05 Pre-Renders", "06 Renders", "07 Deliverables"]

/** What is wrong with each folder, by id. The app checks again when saving; this only points at the row. */
function problemsOf(rows: Row[], kinds: FolderKind[]): Map<string, string> {
  const out = new Map<string, string>()
  const extsOf = (r: Row) => [...r.kinds.flatMap((k) => kinds.find((x) => x.id === k)?.exts ?? []), ...r.extras]
  const names = new Map<string, string>()
  const owner = new Map<string, string>()
  for (const r of rows) {
    const name = r.name.trim()
    if (!name) out.set(r.id, "Give this folder a name.")
    else if (/[/\\:*?"<>|]/.test(name)) out.set(r.id, "Folder names can’t use / \\ : * ? \" < > |")
    else if (name.startsWith(".")) out.set(r.id, "A name can’t start with a dot.")
    else if (name.toLowerCase() === "solids") out.set(r.id, "“Solids” is used by the After Effects bins.")
    else if (names.has(name.toLowerCase())) out.set(r.id, `Another folder is already named “${name}”.`)
    names.set(name.toLowerCase(), r.id)
    for (const ext of extsOf(r)) {
      const other = owner.get(ext)
      if (other && other !== r.id && !out.has(r.id)) {
        const otherName = rows.find((x) => x.id === other)?.name ?? "another folder"
        out.set(r.id, `.${ext} files already go to “${otherName}”.`)
      }
      if (!other) owner.set(ext, r.id)
    }
  }
  return out
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="group/chip inline-flex h-5 items-center gap-0.5 rounded-full bg-muted pr-1 pl-2 text-xs text-muted-foreground">
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="flex size-3.5 items-center justify-center rounded-full opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover/chip:opacity-100"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function FolderRow({
  row,
  kinds,
  problem,
  autoEdit,
  onChange,
  onRemove,
}: {
  row: Row
  kinds: FolderKind[]
  problem?: string
  autoEdit: boolean
  onChange: (next: Row) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  const [editing, setEditing] = useState(autoEdit)
  const [text, setText] = useState(row.name)
  const [typing, setTyping] = useState(false)
  const [extra, setExtra] = useState("")
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) nameInput.current?.select()
  }, [editing])

  function commitName() {
    setEditing(false)
    if (text !== row.name) onChange({ ...row, name: text })
  }
  function addExtras() {
    const found = extra
      .split(/[\s,]+/)
      .map((e) => e.trim().replace(/^\*?\./, "").toLowerCase())
      .filter(Boolean)
    setTyping(false)
    setExtra("")
    if (found.length) onChange({ ...row, extras: [...row.extras, ...found.filter((e) => !row.extras.includes(e))] })
  }
  const free = kinds.filter((k) => !row.kinds.includes(k.id))

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group/row relative rounded-lg", isDragging && "z-10 bg-popover shadow-[0_0_0_1px_var(--border)]")}
    >
      <div className="flex min-h-9 items-center gap-2 py-1 pr-1 pl-1">
        <button
          type="button"
          aria-label={`Move ${row.name || "folder"}`}
          className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        {editing ? (
          <Input
            ref={nameInput}
            aria-label="Folder name"
            value={text}
            maxLength={60}
            className="h-7 w-52 rounded-md px-2 text-sm"
            onChange={(e) => setText(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName()
              if (e.key === "Escape") {
                setText(row.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <button
            type="button"
            title="Rename"
            onClick={() => {
              setText(row.name)
              setEditing(true)
            }}
            className="min-w-0 max-w-52 truncate rounded-md px-1 py-0.5 text-left text-sm font-medium hover:bg-foreground/[0.06]"
          >
            {row.name || <span className="text-muted-foreground">Untitled</span>}
          </button>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {row.kinds.map((k) => (
            <Chip key={k} label={kinds.find((x) => x.id === k)?.label ?? k} onRemove={() => onChange({ ...row, kinds: row.kinds.filter((x) => x !== k) })} />
          ))}
          {row.extras.map((e) => (
            <Chip key={e} label={`.${e}`} onRemove={() => onChange({ ...row, extras: row.extras.filter((x) => x !== e) })} />
          ))}
          {typing ? (
            <Input
              autoFocus
              aria-label="File types"
              placeholder="mp4, mov"
              value={extra}
              className="h-5 w-28 rounded-full px-2 text-xs"
              onChange={(e) => setExtra(e.target.value)}
              onBlur={addExtras}
              onKeyDown={(e) => {
                if (e.key === "Enter") addExtras()
                if (e.key === "Escape") {
                  setExtra("")
                  setTyping(false)
                }
              }}
            />
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Add a file type to ${row.name || "this folder"}`}
                className="flex h-5 items-center gap-0.5 rounded-full px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 aria-expanded:opacity-100 group-hover/row:opacity-100 data-[empty=true]:opacity-100"
                data-empty={row.kinds.length + row.extras.length === 0}
              >
                <Plus className="size-3" />
                {row.kinds.length + row.extras.length === 0 ? "Choose file types" : "Add"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {free.map((k) => (
                  <DropdownMenuItem key={k.id} onClick={() => onChange({ ...row, kinds: [...row.kinds, k.id] })}>
                    {k.label}
                  </DropdownMenuItem>
                ))}
                {free.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onClick={() => setTyping(true)}>Other file type…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${row.name || "folder"}`} className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      {problem && <p role="alert" className="pb-1 pl-[3.25rem] text-xs text-destructive">{problem}</p>}
    </li>
  )
}

/** The folder setup new projects are made with: a tree of `02 Assets`, with the file types that go into each folder. */
export function FolderSetupEditor() {
  const [kinds, setKinds] = useState<FolderKind[] | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle")
  const [fresh, setFresh] = useState<string | null>(null)
  const savedKey = useRef<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  useEffect(() => {
    api
      .getFolderSetup()
      .then((s) => {
        setKinds(s.kinds)
        const r = toRows(s.template.folders)
        setRows(r)
        savedKey.current = keyOf(r)
      })
      .catch((e) => setFailed(errorMessage(e)))
  }, [])

  const problems = useMemo(() => (kinds ? problemsOf(rows, kinds) : new Map<string, string>()), [rows, kinds])

  // Save a moment after the last change, as long as nothing is wrong.
  useEffect(() => {
    if (!kinds || savedKey.current === null) return
    const key = keyOf(rows)
    if (key === savedKey.current || problems.size > 0) return
    const timer = window.setTimeout(() => {
      setState("saving")
      api
        .saveFolderSetup({ folders: toSpecs(rows) })
        .then(() => {
          savedKey.current = key
          setState("saved")
          window.setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1600)
        })
        .catch((e) => {
          setState("idle")
          toast.error(errorMessage(e))
        })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [rows, problems, kinds])

  /** Replace the whole list, with a toast that puts the old one back. */
  function replaceAll(label: string, next: FolderSpec[]) {
    const before = rows
    setRows(toRows(next))
    toast(label, { action: { label: "Undo", onClick: () => setRows(before) } })
  }

  async function reset() {
    const before = rows
    try {
      const s = await api.resetFolderSetup()
      const r = toRows(s.template.folders)
      setRows(r)
      savedKey.current = keyOf(r)
      toast("Back to the Murre default.", { action: { label: "Undo", onClick: () => setRows(before) } })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setRows((cur) => arrayMove(cur, cur.findIndex((r) => r.id === active.id), cur.findIndex((r) => r.id === over.id)))
  }

  function add() {
    const id = newId()
    setFresh(id)
    setRows((cur) => [...cur, { id, name: "New folder", kinds: [], extras: [] }])
  }

  function remove(row: Row) {
    const before = rows
    setRows((cur) => cur.filter((r) => r.id !== row.id))
    toast(`Deleted “${row.name || "folder"}”.`, { action: { label: "Undo", onClick: () => setRows(before) } })
  }

  if (failed) return <p className="px-4 py-3.5 text-sm text-destructive">{failed}</p>
  if (!kinds) return <div className="h-40" />

  const isDefault = keyOf(rows) === JSON.stringify(PRESETS[0].folders)
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span>Start from</span>
        {PRESETS.slice(1).map((p) => (
          <Button key={p.id} variant="outline" size="xs" onClick={() => replaceAll(`Folders set to “${p.label}”.`, p.folders)}>
            {p.label}
          </Button>
        ))}
        <Button variant="ghost" size="xs" className="ml-auto" disabled={isDefault} onClick={() => void reset()}>
          Reset to default
        </Button>
      </div>

      <div className="px-3 py-3">
        <p className="px-2 pb-1 text-xs text-muted-foreground">A new project will look like this</p>
        <ul className="flex flex-col">
          <li className="flex min-h-8 items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
            <span className="size-6 shrink-0" />
            <Folder className="size-4" />
            <span className="flex-1">01 AE Workfile</span>
            <Lock className="size-3 opacity-60" aria-label="Fixed" />
          </li>
          <li className="flex min-h-8 items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
            <span className="size-6 shrink-0" />
            <Folder className="size-4" />
            <span className="flex-1">02 Assets</span>
            <Lock className="size-3 opacity-60" aria-label="Fixed" />
          </li>
        </ul>
        <div className="ml-5 border-l pl-2">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col">
                {rows.map((r) => (
                  <FolderRow
                    key={r.id}
                    row={r}
                    kinds={kinds}
                    problem={problems.get(r.id)}
                    autoEdit={r.id === fresh}
                    onChange={(next) => setRows((cur) => cur.map((x) => (x.id === next.id ? next : x)))}
                    onRemove={() => remove(r)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {rows.length === 0 && <p className="py-2 pl-9 text-sm text-muted-foreground">No sub-folders. Everything goes straight into 02 Assets.</p>}
          <Button variant="ghost" size="sm" className="mt-1 ml-1 text-muted-foreground" onClick={add}>
            <Plus /> Add folder
          </Button>
        </div>
        <p className="mt-2 px-3 text-xs text-muted-foreground/80">
          {FIXED_REST.join(" · ")} <span className="inline-flex translate-y-0.5"><Lock className="size-3 opacity-60" aria-label="Fixed" /></span>
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span>Changes apply to new projects. Existing projects keep the folders they have.</span>
        <span aria-live="polite" className={cn("shrink-0 transition-opacity", state === "idle" ? "opacity-0" : "opacity-100")}>
          {state === "saving" ? "Saving…" : "Saved"}
        </span>
      </div>
    </div>
  )
}
