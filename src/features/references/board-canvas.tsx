import { openUrl } from "@tauri-apps/plugin-opener"
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  BringToFront,
  Copy,
  ExternalLink,
  FileText,
  ImageOff,
  Link2,
  Maximize,
  Minus,
  Paintbrush,
  Plus,
  SendToBack,
  Trash2,
} from "lucide-react"
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { api, errorMessage } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import {
  BOARD_FORMAT,
  clampZoom,
  DEFAULT_STROKE,
  isLine,
  isShape,
  itemRect,
  lineEnds,
  lineFrom,
  newId,
  normalizeUrl,
  rectsIntersect,
  SHAPE_COLORS,
  SHAPE_WEIGHTS,
  startSize,
  unionRect,
  type Board,
  type Item,
  type Rect,
  type View,
} from "./board"
import {
  alignItems,
  anchorFor,
  distributeItems,
  reorder,
  resizeFactor,
  scaleItems,
  snapMove,
  type AlignKind,
  type Corner,
  type Guide,
} from "./geometry"
import { importMedia, looksLikeSvg, measureMedia, mediaUrl } from "./media"

const SELECT_BLUE = "#0d99ff"
const GUIDE_RED = "#f24822"
const SNAP_PX = 6
const HANDLE_PX = 9
const HISTORY_LIMIT = 100
const COPY_MARKER = "sequenxe-board-items"

export interface BoardHandle {
  addFiles: (files: File[], at?: { x: number; y: number }) => Promise<void>
  addLink: (url: string) => void
  addText: () => void
  addShape: (kind: "rect" | "ellipse" | "line" | "arrow") => void
  getBoard: () => Board
}

interface Props {
  projectId: string | null
  initial: Board
  /** Pan, zoom and selection still work; nothing can be changed or saved. */
  readOnly?: boolean
  /** Called after every change the user makes to the items. */
  onChange: (board: Board) => void
  /** Keyboard shortcuts `I` and `K` ask the host to open its file picker or link dialog. */
  onPickFile?: () => void
  onPickLink?: () => void
  ref?: Ref<BoardHandle>
}

type Gesture =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | {
      kind: "move"
      cx: number
      cy: number
      startX: number
      startY: number
      before: Item[]
      ids: Set<string>
      origRect: Rect
      moved: boolean
      hitId: string
      shift: boolean
    }
  | { kind: "resize"; corner: Corner; before: Item[]; ids: Set<string>; origRect: Rect }
  | { kind: "width"; before: Item[]; id: string }
  | { kind: "shape"; corner: Corner; before: Item[]; id: string; orig: Rect }
  | { kind: "end"; which: "a" | "b"; before: Item[]; id: string }
  | { kind: "marquee"; sx: number; sy: number; base: Set<string> }

let internalClipboard: Item[] = []

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable
}

export function BoardCanvas({ projectId, initial, readOnly = false, onChange, onPickFile, onPickLink, ref }: Props) {
  const vpRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; file: string } | null>(null)
  const [items, setItems] = useState<Item[]>(initial.items)
  const itemsRef = useRef<Item[]>(initial.items)
  const [view, setViewState] = useState<View>(initial.view ?? { x: 0, y: 0, zoom: 1 })
  const viewRef = useRef<View>(view)
  const [selection, setSelectionState] = useState<Set<string>>(new Set())
  const selRef = useRef<Set<string>>(selection)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editingRef = useRef<string | null>(null)
  const editBefore = useRef<Item[] | null>(null)
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(new Map())
  const measuredRef = useRef(measured)
  const [guides, setGuides] = useState<Guide[]>([])
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [panning, setPanning] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const space = useRef(false)
  const past = useRef<Item[][]>([])
  const future = useRef<Item[][]>([])
  const pasteCount = useRef(0)
  /** What the last pointer press landed on. A double-click is reported on the captured element, so it cannot tell. */
  const lastPress = useRef<{ itemId: string | null; ignore: boolean }>({ itemId: null, ignore: false })

  measuredRef.current = measured
  editingRef.current = editingId

  const setView = useCallback((v: View) => {
    viewRef.current = v
    setViewState(v)
  }, [])
  const select = useCallback((ids: Set<string>) => {
    selRef.current = ids
    setSelectionState(ids)
  }, [])
  const setLive = useCallback((next: Item[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])
  const getBoard = useCallback(
    (): Board => ({ format: BOARD_FORMAT, version: 1, items: itemsRef.current, view: viewRef.current }),
    [],
  )
  const commit = useCallback(
    (before: Item[], next: Item[]) => {
      if (readOnly) return setLive(before)
      past.current.push(before)
      if (past.current.length > HISTORY_LIMIT) past.current.shift()
      future.current = []
      setLive(next)
      onChange({ format: BOARD_FORMAT, version: 1, items: next, view: viewRef.current })
    },
    [onChange, readOnly, setLive],
  )
  const apply = useCallback((next: Item[]) => commit(itemsRef.current, next), [commit])

  // ---- view helpers

  const vpSize = () => {
    const r = vpRef.current?.getBoundingClientRect()
    return { w: r?.width ?? 800, h: r?.height ?? 600 }
  }
  const toWorld = (clientX: number, clientY: number) => {
    const r = vpRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }
  const viewportCenter = () => {
    const { w, h } = vpSize()
    const v = viewRef.current
    return { x: (w / 2 - v.x) / v.zoom, y: (h / 2 - v.y) / v.zoom }
  }
  const zoomTo = (nz: number, cx: number, cy: number) => {
    const v = viewRef.current
    const z = clampZoom(nz)
    const k = z / v.zoom
    setView({ x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, zoom: z })
  }
  const zoomBy = (factor: number) => {
    const { w, h } = vpSize()
    zoomTo(viewRef.current.zoom * factor, w / 2, h / 2)
  }
  const fitRect = (rect: Rect, maxZoom: number) => {
    const { w, h } = vpSize()
    const pad = 64
    const z = clampZoom(Math.min((w - 2 * pad) / rect.w, (h - 2 * pad) / rect.h, maxZoom))
    setView({ zoom: z, x: w / 2 - (rect.x + rect.w / 2) * z, y: h / 2 - (rect.y + rect.h / 2) * z })
  }
  const fitAll = () => {
    const u = unionRect(itemsRef.current.map((i) => itemRect(i, measuredRef.current)))
    if (u) fitRect(u, 1.5)
    else setView({ x: vpSize().w / 2, y: vpSize().h / 2, zoom: 1 })
  }

  // First view: the saved one, or everything in frame.
  useLayoutEffect(() => {
    if (initial.view) return
    const u = unionRect(initial.items.map((i) => itemRect(i, new Map())))
    if (u) fitRect(u, 1)
    else setView({ x: vpSize().w / 2, y: vpSize().h / 2, zoom: 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onMeasure = useCallback((id: string, h: number) => {
    setMeasured((m) => {
      if (Math.abs((m.get(id) ?? -1) - h) < 0.5) return m
      const n = new Map(m)
      n.set(id, h)
      return n
    })
  }, [])

  // ---- adding things

  const addItems = (list: Item[]) => {
    if (list.length === 0) return
    apply([...itemsRef.current, ...list])
    select(new Set(list.map((i) => i.id)))
  }

  /** Lays new items out in rows centred on `at` (default: the middle of the screen). */
  const placeRow = (sizes: { w: number; h: number }[], at?: { x: number; y: number }) => {
    const c = { ...(at ?? viewportCenter()) }
    if (!at) {
      // Do not stack new items exactly on top of ones added the same way before.
      const near = (x: number, y: number) => itemsRef.current.some((i) => Math.abs(i.x + i.w / 2 - x) < 12 && Math.abs(i.y + i.h / 2 - y) < 12)
      while (near(c.x, c.y)) {
        c.x += 28
        c.y += 28
      }
    }
    const gap = 24
    const perRow = 4
    const out: { x: number; y: number }[] = []
    for (let start = 0; start < sizes.length; start += perRow) {
      const row = sizes.slice(start, start + perRow)
      const rowW = row.reduce((n, s) => n + s.w, 0) + gap * (row.length - 1)
      const rowH = Math.max(...row.map((s) => s.h))
      const top = c.y - rowH / 2 + (start / perRow) * (rowH + gap)
      let x = c.x - rowW / 2
      for (const s of row) {
        out.push({ x, y: top + (rowH - s.h) / 2 })
        x += s.w + gap
      }
    }
    return out
  }

  const addFiles = async (files: File[], at?: { x: number; y: number }) => {
    if (readOnly || files.length === 0) return
    const made: Omit<Item, "x" | "y">[] = []
    for (const file of files) {
      try {
        const media = await importMedia(projectId, file)
        if (media.mediaType === "pdf") {
          made.push({ id: newId(), type: "pdf", w: 260, h: 72, file: media.file, name: file.name })
        } else {
          const size = await measureMedia(file, media.mediaType)
          // An icon is often 24 px wide: an SVG can be any size, so it starts big enough to see.
          const svg = media.file.endsWith(".svg")
          const ratio = size && size.w > 0 && size.h > 0 ? size.w / size.h : 1
          const { w, h } = svg
            ? { w: Math.round(ratio >= 1 ? 200 : 200 * ratio), h: Math.round(ratio >= 1 ? 200 / ratio : 200) }
            : startSize(size?.w ?? 0, size?.h ?? 0)
          made.push({ id: newId(), type: media.mediaType, w, h, file: media.file })
        }
      } catch (e) {
        toast.error(`${file.name}: ${errorMessage(e)}`)
      }
    }
    const spots = placeRow(made, at)
    addItems(made.map((m, i) => ({ ...m, ...spots[i] })))
  }

  const addLink = (raw: string) => {
    const url = normalizeUrl(raw)
    if (!url || readOnly) return
    const c = viewportCenter()
    addItems([{ id: newId(), type: "link", x: c.x - 140, y: c.y - 36, w: 280, h: 72, url }])
  }

  const addText = (at?: { x: number; y: number }, text = "") => {
    if (readOnly) return
    const c = at ?? viewportCenter()
    const item: Item = { id: newId(), type: "text", x: c.x, y: c.y - 16, w: 240, h: 32, text, fontSize: 24 }
    if (text) return addItems([item])
    // An empty text box only becomes part of the board once something is typed.
    editBefore.current = itemsRef.current
    setLive([...itemsRef.current, item])
    select(new Set([item.id]))
    setEditingId(item.id)
  }

  /** A shape in the middle of what you are looking at, selected so it can be adjusted right away. */
  const addShape = (kind: "rect" | "ellipse" | "line" | "arrow") => {
    if (readOnly) return
    const c = viewportCenter()
    const size = kind === "line" || kind === "arrow" ? { w: 240, h: 0 } : { w: 240, h: 160 }
    addItems([{ id: newId(), type: kind, x: c.x - size.w / 2, y: c.y - size.h / 2, ...size }])
  }

  const finishEdit = (id: string, raw: string) => {
    const text = raw.replace(/\s+$/, "")
    const cur = itemsRef.current
    const it = cur.find((i) => i.id === id)
    const before = editBefore.current ?? cur
    editBefore.current = null
    setEditingId(null)
    // Keep shortcuts (undo, delete) working after the editor closes, unless focus went somewhere else on purpose.
    window.setTimeout(() => document.activeElement === document.body && vpRef.current?.focus({ preventScroll: true }), 0)
    if (!it) return
    if (!text.trim()) {
      const next = cur.filter((i) => i.id !== id)
      if (before === cur) commit(cur, next)
      else setLive(next)
      select(new Set())
      return
    }
    if (text === it.text && before === cur) return
    commit(
      before,
      cur.map((i) => (i.id === id ? { ...i, text } : i)),
    )
  }

  // ---- editing commands

  const selectedItems = () => itemsRef.current.filter((i) => selRef.current.has(i.id))

  const deleteSelection = () => {
    if (selRef.current.size === 0) return
    apply(itemsRef.current.filter((i) => !selRef.current.has(i.id)))
    select(new Set())
  }

  const duplicate = (offset = 24) => {
    const copies = (selectedItems().length ? selectedItems() : internalClipboard).map((i) => ({
      ...i,
      id: newId(),
      x: i.x + offset,
      y: i.y + offset,
    }))
    addItems(copies)
  }

  const nudge = (dx: number, dy: number) => {
    if (selRef.current.size === 0) return
    apply(itemsRef.current.map((i) => (selRef.current.has(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i)))
  }

  const undo = () => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(itemsRef.current)
    setLive(prev)
    onChange({ format: BOARD_FORMAT, version: 1, items: prev, view: viewRef.current })
    select(new Set([...selRef.current].filter((id) => prev.some((i) => i.id === id))))
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(itemsRef.current)
    setLive(next)
    onChange({ format: BOARD_FORMAT, version: 1, items: next, view: viewRef.current })
    select(new Set([...selRef.current].filter((id) => next.some((i) => i.id === id))))
  }

  const openItem = (it: Item) => {
    if (it.type === "pdf" && it.file) api.openReferenceMedia(projectId, it.file).catch((e) => toast.error(errorMessage(e)))
    else if (it.type === "link" && it.url) openUrl(it.url).catch((e) => toast.error(errorMessage(e)))
  }

  /** Right-click on an image: offer to send it to After Effects. */
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const id = (e.target as HTMLElement).closest("[data-item-id]")?.getAttribute("data-item-id")
    const it = id ? itemsRef.current.find((i) => i.id === id) : undefined
    const vp = vpRef.current
    if (!it || it.type !== "image" || !it.file || !vp) return setMenu(null)
    select(new Set([it.id]))
    const r = vp.getBoundingClientRect()
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, file: it.file })
  }

  const sendToAe = (file: string, asShapes = false) => {
    setMenu(null)
    const t = toast.loading("Sending to After Effects…")
    api
      .sendReferenceToAfterEffects(projectId, file, asShapes)
      .then((r) =>
        toast.success(
          r.created
            ? `Made the comp “${r.comp}” and added the ${asShapes ? "shapes" : "image"}`
            : `Added ${asShapes ? "the shapes " : ""}to “${r.comp}”`,
          { id: t },
        ),
      )
      .catch((e) => toast.error(errorMessage(e), { id: t }))
  }

  // Close the menu on Escape or any press outside it.
  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return
      if (e instanceof PointerEvent && (e.target as HTMLElement).closest("[data-ae-menu]")) return
      setMenu(null)
    }
    window.addEventListener("pointerdown", close, true)
    window.addEventListener("keydown", close, true)
    window.addEventListener("blur", close)
    return () => {
      window.removeEventListener("pointerdown", close, true)
      window.removeEventListener("keydown", close, true)
      window.removeEventListener("blur", close)
    }
  }, [menu])

  // Keyboard shortcuts keep working after a toolbar button is used (or disappears).
  const refocus = () => vpRef.current?.focus({ preventScroll: true })

  // ---- pointer

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const vp = vpRef.current
    if (!vp) return
    const target = e.target as HTMLElement
    lastPress.current = {
      itemId: target.closest("[data-item-id]")?.getAttribute("data-item-id") ?? null,
      ignore: !!(target.closest("[data-ui]") || target.closest("[data-handle]") || target.closest("[data-editor]")),
    }
    if (target.closest("[data-ui]")) return
    if (editingRef.current && target.closest("[data-editor]")) return
    if (e.button === 2) return
    if (editingRef.current) (document.activeElement as HTMLElement | null)?.blur()
    vp.focus({ preventScroll: true })
    vp.setPointerCapture(e.pointerId)

    if (e.button === 1 || space.current) {
      e.preventDefault()
      const v = viewRef.current
      gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y }
      setPanning(true)
      return
    }
    if (e.button !== 0) return

    const p = toWorld(e.clientX, e.clientY)
    const handle = target.closest("[data-handle]")?.getAttribute("data-handle")
    if (handle && !readOnly) {
      const ids = selRef.current
      const sel = itemsRef.current.filter((i) => ids.has(i.id))
      if (handle === "e") {
        gesture.current = { kind: "width", before: itemsRef.current, id: sel[0].id }
      } else if (handle === "a" || handle === "b") {
        gesture.current = { kind: "end", which: handle, before: itemsRef.current, id: sel[0].id }
      } else if (sel.length === 1 && (sel[0].type === "rect" || sel[0].type === "ellipse")) {
        // Rectangles and ellipses stretch freely; everything else keeps its proportions.
        gesture.current = { kind: "shape", corner: handle as Corner, before: itemsRef.current, id: sel[0].id, orig: itemRect(sel[0], measuredRef.current) }
      } else {
        const origRect = unionRect(sel.map((i) => itemRect(i, measuredRef.current)))!
        gesture.current = { kind: "resize", corner: handle as Corner, before: itemsRef.current, ids: new Set(ids), origRect }
      }
      return
    }

    const hitEl = target.closest("[data-item-id]")
    const hitId = hitEl?.getAttribute("data-item-id") ?? null
    if (hitId) {
      let ids = selRef.current
      if (e.shiftKey) {
        ids = new Set(ids)
        if (ids.has(hitId)) ids.delete(hitId)
        else ids.add(hitId)
        select(ids)
        if (!ids.has(hitId)) return
      } else if (!ids.has(hitId)) {
        ids = new Set([hitId])
        select(ids)
      }
      const sel = itemsRef.current.filter((i) => ids.has(i.id))
      gesture.current = {
        kind: "move",
        cx: e.clientX,
        cy: e.clientY,
        startX: p.x,
        startY: p.y,
        before: itemsRef.current,
        ids: new Set(ids),
        origRect: unionRect(sel.map((i) => itemRect(i, measuredRef.current)))!,
        moved: false,
        hitId,
        shift: e.shiftKey,
      }
      return
    }

    const base = e.shiftKey ? new Set(selRef.current) : new Set<string>()
    if (!e.shiftKey) select(new Set())
    gesture.current = { kind: "marquee", sx: e.clientX, sy: e.clientY, base }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g) return
    const zoom = viewRef.current.zoom
    if (g.kind === "pan") {
      setView({ ...viewRef.current, x: g.vx + (e.clientX - g.sx), y: g.vy + (e.clientY - g.sy) })
    } else if (g.kind === "move") {
      if (!g.moved && Math.hypot(e.clientX - g.cx, e.clientY - g.cy) < 3) return
      g.moved = true
      const p = toWorld(e.clientX, e.clientY)
      let dx = p.x - g.startX
      let dy = p.y - g.startY
      let found: Guide[] = []
      if (!e.altKey) {
        const others = g.before.filter((i) => !g.ids.has(i.id)).map((i) => itemRect(i, measuredRef.current))
        const s = snapMove({ ...g.origRect, x: g.origRect.x + dx, y: g.origRect.y + dy }, others, SNAP_PX / zoom)
        dx += s.dx
        dy += s.dy
        found = s.guides
      }
      setGuides(found)
      setLive(g.before.map((i) => (g.ids.has(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i)))
    } else if (g.kind === "resize") {
      const p = toWorld(e.clientX, e.clientY)
      const factor = resizeFactor(g.origRect, g.corner, p)
      const anchor = anchorFor(g.origRect, g.corner)
      const originals = g.before.filter((i) => g.ids.has(i.id))
      const scaled = new Map(scaleItems(originals, anchor, factor).map((i) => [i.id, i]))
      setLive(g.before.map((i) => scaled.get(i.id) ?? i))
    } else if (g.kind === "shape") {
      const p = toWorld(e.clientX, e.clientY)
      const fixed = anchorFor(g.orig, g.corner)
      const MIN = 8
      let nx = p.x
      let ny = p.y
      // Cannot be dragged smaller than a few pixels or past the opposite corner.
      if (g.corner.includes("w")) nx = Math.min(nx, fixed.x - MIN)
      else nx = Math.max(nx, fixed.x + MIN)
      if (g.corner.includes("n")) ny = Math.min(ny, fixed.y - MIN)
      else ny = Math.max(ny, fixed.y + MIN)
      const r = { x: Math.min(fixed.x, nx), y: Math.min(fixed.y, ny), w: Math.abs(nx - fixed.x), h: Math.abs(ny - fixed.y) }
      setLive(g.before.map((i) => (i.id === g.id ? { ...i, ...r } : i)))
    } else if (g.kind === "end") {
      const p = toWorld(e.clientX, e.clientY)
      setLive(
        g.before.map((i) => {
          if (i.id !== g.id) return i
          const ends = lineEnds(i)
          return { ...i, ...(g.which === "a" ? lineFrom(p, ends.b) : lineFrom(ends.a, p)) }
        }),
      )
    } else if (g.kind === "width") {
      const p = toWorld(e.clientX, e.clientY)
      setLive(g.before.map((i) => (i.id === g.id ? { ...i, w: Math.max(40, p.x - i.x) } : i)))
    } else if (g.kind === "marquee") {
      const vp = vpRef.current!.getBoundingClientRect()
      const r = {
        x: Math.min(g.sx, e.clientX) - vp.left,
        y: Math.min(g.sy, e.clientY) - vp.top,
        w: Math.abs(e.clientX - g.sx),
        h: Math.abs(e.clientY - g.sy),
      }
      setMarquee(r)
      const a = toWorld(Math.min(g.sx, e.clientX), Math.min(g.sy, e.clientY))
      const b = toWorld(Math.max(g.sx, e.clientX), Math.max(g.sy, e.clientY))
      const box = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
      const ids = new Set(g.base)
      for (const it of itemsRef.current) if (rectsIntersect(box, itemRect(it, measuredRef.current))) ids.add(it.id)
      select(ids)
    }
  }

  const endGesture = () => {
    const g = gesture.current
    gesture.current = null
    setPanning(false)
    setMarquee(null)
    setGuides([])
    if (!g) return
    if (g.kind === "move") {
      if (!g.moved) {
        // A plain click on one item of a multi-selection narrows the selection to it.
        if (!g.shift && g.ids.size > 1) select(new Set([g.hitId]))
        return
      }
      if (itemsRef.current !== g.before) commit(g.before, itemsRef.current)
    } else if (g.kind === "resize" || g.kind === "width" || g.kind === "shape" || g.kind === "end") {
      if (itemsRef.current !== g.before) commit(g.before, itemsRef.current)
    }
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { itemId, ignore } = lastPress.current
    if (ignore) return
    const it = itemId ? itemsRef.current.find((i) => i.id === itemId) : null
    if (it?.type === "text") {
      if (!readOnly) {
        editBefore.current = null
        setEditingId(it.id)
      }
    } else if (it) openItem(it)
    else addText(toWorld(e.clientX, e.clientY))
  }

  // ---- keyboard

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingRef.current || isEditable(e.target)) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    if (e.key === " ") {
      space.current = true
      e.preventDefault()
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault()
      deleteSelection()
    } else if (e.key === "Escape") {
      select(new Set())
    } else if (e.key === "Enter") {
      const only = selectedItems()
      if (only.length === 1 && only[0].type === "text" && !readOnly) {
        editBefore.current = null
        setEditingId(only[0].id)
        e.preventDefault()
      }
    } else if (!mod && !e.shiftKey && !e.altKey && key === "t") {
      e.preventDefault()
      addText()
    } else if (!mod && !e.shiftKey && !e.altKey && key === "i" && !readOnly) {
      e.preventDefault()
      onPickFile?.()
    } else if (!mod && !e.shiftKey && !e.altKey && key === "k" && !readOnly) {
      e.preventDefault()
      onPickLink?.()
    } else if (mod && key === "a") {
      e.preventDefault()
      select(new Set(itemsRef.current.map((i) => i.id)))
    } else if (mod && key === "z") {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (mod && key === "y") {
      e.preventDefault()
      redo()
    } else if (mod && key === "d") {
      e.preventDefault()
      duplicate()
    } else if (mod && (e.key === "]" || e.key === "[")) {
      e.preventDefault()
      const dir = e.key === "]" ? (e.shiftKey ? "front" : "forward") : e.shiftKey ? "back" : "backward"
      apply(reorder(itemsRef.current, selRef.current, dir))
    } else if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault()
      zoomBy(1.25)
    } else if (mod && e.key === "-") {
      e.preventDefault()
      zoomBy(0.8)
    } else if (mod && e.key === "0") {
      e.preventDefault()
      const { w, h } = vpSize()
      zoomTo(1, w / 2, h / 2)
    } else if (e.shiftKey && e.code === "Digit1") {
      e.preventDefault()
      fitAll()
    } else if (e.shiftKey && e.code === "Digit2") {
      const u = unionRect(selectedItems().map((i) => itemRect(i, measuredRef.current)))
      if (u) fitRect(u, 2)
    } else if (e.key.startsWith("Arrow") && selRef.current.size > 0) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0)
    }
  }
  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " ") space.current = false
  }

  // Wheel / pinch / clipboard need native listeners (wheel must be non-passive), so they call the latest handlers.
  const latest = useRef({ zoomTo, pasteEvent: (_e: ClipboardEvent) => {}, copyEvent: (_e: ClipboardEvent, _cut: boolean) => {} })
  latest.current = {
    zoomTo,
    pasteEvent: (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length > 0) {
        e.preventDefault()
        void addFiles(files)
        return
      }
      const text = e.clipboardData?.getData("text/plain") ?? ""
      if (text === COPY_MARKER && internalClipboard.length > 0) {
        e.preventDefault()
        pasteCount.current += 1
        const off = 24 * pasteCount.current
        addItems(internalClipboard.map((i) => ({ ...i, id: newId(), x: i.x + off, y: i.y + off })))
      } else if (!editingId && looksLikeSvg(text)) {
        // SVG code (for example "Copy as SVG" from a design tool) becomes an SVG file on the board.
        e.preventDefault()
        void addFiles([new File([text], "pasted.svg", { type: "image/svg+xml" })])
      } else if (text.trim()) {
        e.preventDefault()
        const url = /^https?:\/\//i.test(text.trim()) && !/\s/.test(text.trim()) ? normalizeUrl(text) : null
        if (url) addLink(url)
        else addText(undefined, text.trim().slice(0, 5000))
      }
    },
    copyEvent: (e: ClipboardEvent, cut: boolean) => {
      if (selRef.current.size === 0) return
      internalClipboard = selectedItems()
      pasteCount.current = 0
      e.clipboardData?.setData("text/plain", COPY_MARKER)
      e.preventDefault()
      if (cut) deleteSelection()
    },
  }

  useEffect(() => {
    const vp = vpRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = vp.getBoundingClientRect()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        latest.current.zoomTo(v.zoom * Math.exp(-Math.max(-40, Math.min(40, e.deltaY)) * 0.01), e.clientX - r.left, e.clientY - r.top)
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
      }
    }
    // Safari/WebKit reports trackpad pinch as gesture events.
    let gestureStartZoom = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureStartZoom = viewRef.current.zoom
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      const ge = e as Event & { scale: number; clientX: number; clientY: number }
      const r = vp.getBoundingClientRect()
      latest.current.zoomTo(gestureStartZoom * ge.scale, ge.clientX - r.left, ge.clientY - r.top)
    }
    vp.addEventListener("wheel", onWheel, { passive: false })
    vp.addEventListener("gesturestart", onGestureStart)
    vp.addEventListener("gesturechange", onGestureChange)

    const inBoard = (t: EventTarget | null) => !isEditable(t) && (document.activeElement === document.body || vp.contains(document.activeElement))
    const onPaste = (e: ClipboardEvent) => inBoard(e.target) && latest.current.pasteEvent(e)
    const onCopy = (e: ClipboardEvent) => inBoard(e.target) && latest.current.copyEvent(e, false)
    const onCut = (e: ClipboardEvent) => inBoard(e.target) && latest.current.copyEvent(e, true)
    document.addEventListener("paste", onPaste)
    document.addEventListener("copy", onCopy)
    document.addEventListener("cut", onCut)
    return () => {
      vp.removeEventListener("wheel", onWheel)
      vp.removeEventListener("gesturestart", onGestureStart)
      vp.removeEventListener("gesturechange", onGestureChange)
      document.removeEventListener("paste", onPaste)
      document.removeEventListener("copy", onCopy)
      document.removeEventListener("cut", onCut)
    }
  }, [setView])

  useImperativeHandle(ref, () => ({ addFiles, addLink, addText: () => addText(), addShape, getBoard }))

  // ---- render

  const selected = items.filter((i) => selection.has(i.id))
  const group = unionRect(selected.map((i) => itemRect(i, measured)))
  const only = selected.length === 1 ? selected[0] : null
  const hs = HANDLE_PX / view.zoom
  const line = 1.5 / view.zoom
  const gridPx = 24 * view.zoom

  const ends = only && isLine(only) ? lineEnds(only) : null
  const handles: { id: string; x: number; y: number; cursor: string }[] = ends
    ? [
        { id: "a", x: ends.a.x, y: ends.a.y, cursor: "crosshair" },
        { id: "b", x: ends.b.x, y: ends.b.y, cursor: "crosshair" },
      ]
    : group
    ? [
        { id: "nw", x: group.x, y: group.y, cursor: "nwse-resize" },
        { id: "ne", x: group.x + group.w, y: group.y, cursor: "nesw-resize" },
        { id: "sw", x: group.x, y: group.y + group.h, cursor: "nesw-resize" },
        { id: "se", x: group.x + group.w, y: group.y + group.h, cursor: "nwse-resize" },
      ]
    : []

  return (
    <div
      ref={vpRef}
      tabIndex={0}
      role="application"
      aria-label="Reference board"
      className={cn(
        "relative size-full touch-none overflow-hidden bg-muted/30 outline-none select-none",
        panning ? "cursor-grabbing" : "cursor-default",
      )}
      style={
        gridPx >= 8
          ? {
              backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1.2px)",
              backgroundSize: `${gridPx}px ${gridPx}px`,
              backgroundPosition: `${view.x}px ${view.y}px`,
            }
          : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const files = Array.from(e.dataTransfer.files)
        if (files.length) void addFiles(files, toWorld(e.clientX, e.clientY))
      }}
    >
      {menu && (
        <div
          data-ui
          data-ae-menu
          role="menu"
          className="absolute z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.file.endsWith(".svg") ? (
            <>
              <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => sendToAe(menu.file, true)}>
                Send to After Effects as shapes
              </button>
              <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => sendToAe(menu.file)}>
                Send to After Effects as a layer
              </button>
            </>
          ) : (
            <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => sendToAe(menu.file)}>
              Send to After Effects
            </button>
          )}
        </div>
      )}
      <div
        className="absolute top-0 left-0"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0" }}
      >
        {items.map((it) => (
          <ItemView key={it.id} item={it} projectId={projectId} editing={editingId === it.id} selected={selection.has(it.id)} onMeasure={onMeasure} onFinishEdit={finishEdit} />
        ))}

        {selected.filter((it) => !isLine(it)).map((it) => {
          const r = itemRect(it, measured)
          return (
            <div
              key={it.id}
              className="pointer-events-none absolute"
              style={{ left: r.x, top: r.y, width: r.w, height: r.h, outline: `${line}px solid ${SELECT_BLUE}` }}
            />
          )
        })}

        {group && !editingId && !readOnly && (
          <>
            {selected.length > 1 && (
              <div
                className="pointer-events-none absolute"
                style={{ left: group.x, top: group.y, width: group.w, height: group.h, outline: `${line}px dashed ${SELECT_BLUE}` }}
              />
            )}
            {handles.map((h) => (
              <div
                key={h.id}
                data-handle={h.id}
                className="absolute"
                style={{
                  left: h.x - hs / 2,
                  top: h.y - hs / 2,
                  width: hs,
                  height: hs,
                  cursor: h.cursor,
                  background: "#fff",
                  border: `${line}px solid ${SELECT_BLUE}`,
                }}
              />
            ))}
            {only?.type === "text" && (
              <div
                data-handle="e"
                className="absolute"
                style={{
                  left: group.x + group.w - hs / 2,
                  top: group.y + group.h / 2 - hs,
                  width: hs,
                  height: hs * 2,
                  cursor: "ew-resize",
                  background: "#fff",
                  border: `${line}px solid ${SELECT_BLUE}`,
                  borderRadius: hs,
                }}
              />
            )}
          </>
        )}

        {guides.map((g, i) =>
          g.axis === "x" ? (
            <div key={i} className="pointer-events-none absolute" style={{ left: g.at - line / 2, top: g.from, width: line, height: g.to - g.from, background: GUIDE_RED }} />
          ) : (
            <div key={i} className="pointer-events-none absolute" style={{ top: g.at - line / 2, left: g.from, height: line, width: g.to - g.from, background: GUIDE_RED }} />
          ),
        )}
      </div>

      {marquee && (
        <div
          className="pointer-events-none absolute"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, background: `${SELECT_BLUE}1f`, border: `1px solid ${SELECT_BLUE}` }}
        />
      )}

      {items.length === 0 && !editingId && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Add images with “Add file”, paste them, or double-click to write some text.
        </div>
      )}

      {selected.length > 0 && !editingId && !readOnly && (
        <div
          data-ui
          onClick={refocus}
          className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground"
        >
          {selected.length > 1 && (
            <>
              <Tool label="Align left" onClick={() => alignTo("left")}><AlignStartVertical /></Tool>
              <Tool label="Align horizontal centers" onClick={() => alignTo("center")}><AlignCenterVertical /></Tool>
              <Tool label="Align right" onClick={() => alignTo("right")}><AlignEndVertical /></Tool>
              <Tool label="Align top" onClick={() => alignTo("top")}><AlignStartHorizontal /></Tool>
              <Tool label="Align vertical centers" onClick={() => alignTo("middle")}><AlignCenterHorizontal /></Tool>
              <Tool label="Align bottom" onClick={() => alignTo("bottom")}><AlignEndHorizontal /></Tool>
              {selected.length > 2 && (
                <>
                  <Tool label="Distribute horizontally" onClick={() => apply(distributeItems(itemsRef.current, selRef.current, "x", measuredRef.current))}>
                    <AlignHorizontalSpaceBetween />
                  </Tool>
                  <Tool label="Distribute vertically" onClick={() => apply(distributeItems(itemsRef.current, selRef.current, "y", measuredRef.current))}>
                    <AlignVerticalSpaceBetween />
                  </Tool>
                </>
              )}
              <span className="mx-1 h-4 w-px bg-border" />
            </>
          )}
          {only && (only.type === "pdf" || only.type === "link") && (
            <Tool label={only.type === "pdf" ? "Open PDF" : "Open link"} onClick={() => openItem(only)}><ExternalLink /></Tool>
          )}
          {selected.every(isShape) && <ShapeStyle shapes={selected} onChange={(patch) => apply(itemsRef.current.map((i) => (selRef.current.has(i.id) && isShape(i) ? { ...i, ...patch } : i)))} />}
          <Tool label="Bring to front" onClick={() => apply(reorder(itemsRef.current, selRef.current, "front"))}><BringToFront /></Tool>
          <Tool label="Send to back" onClick={() => apply(reorder(itemsRef.current, selRef.current, "back"))}><SendToBack /></Tool>
          <Tool label="Duplicate" onClick={() => duplicate()}><Copy /></Tool>
          <Tool label="Delete" onClick={deleteSelection}><Trash2 /></Tool>
        </div>
      )}

      <div data-ui onClick={refocus} className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground">
        <Tool label="Zoom out" onClick={() => zoomBy(0.8)}><Minus /></Tool>
        <button
          type="button"
          aria-label="Reset zoom to 100%"
          title="Reset zoom to 100%"
          className="h-7 min-w-12 rounded-md px-1 text-xs tabular-nums hover:bg-accent"
          onClick={() => {
            const { w, h } = vpSize()
            zoomTo(1, w / 2, h / 2)
          }}
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <Tool label="Zoom in" onClick={() => zoomBy(1.25)}><Plus /></Tool>
        <Tool label="Fit everything" onClick={fitAll}><Maximize /></Tool>
      </div>
    </div>
  )

  function alignTo(kind: AlignKind) {
    apply(alignItems(itemsRef.current, selRef.current, kind, measuredRef.current))
  }
}

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={onClick}>
      {children}
    </Button>
  )
}

// ---------------------------------------------------------------- items

interface ItemViewProps {
  item: Item
  projectId: string | null
  editing: boolean
  selected: boolean
  onMeasure: (id: string, h: number) => void
  onFinishEdit: (id: string, text: string) => void
}

const ItemView = memo(function ItemView({ item, projectId, editing, selected, onMeasure, onFinishEdit }: ItemViewProps) {
  const style: React.CSSProperties = {
    left: item.x,
    top: item.y,
    width: item.w,
    height: item.type === "text" ? undefined : item.h,
    // Outlines can only be picked up by their line, so the empty inside does not get in the way of what is under them.
    pointerEvents: item.type === "rect" || item.type === "ellipse" ? "none" : undefined,
  }
  return (
    <div data-item-id={item.id} className="absolute" style={style}>
      {(item.type === "image" || item.type === "video") && item.file && <Media projectId={projectId} file={item.file} video={item.type === "video"} />}
      {item.type === "text" && <TextBody item={item} editing={editing} onMeasure={onMeasure} onFinishEdit={onFinishEdit} />}
      {(item.type === "rect" || item.type === "ellipse" || item.type === "line" || item.type === "arrow") && <ShapeBody item={item} selected={selected} />}
      {item.type === "pdf" && (
        <div className="pointer-events-none flex size-full items-center gap-3 rounded-lg border bg-card px-4 text-card-foreground">
          <FileText className="size-6 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{item.name ?? "PDF"}</p>
            <p className="text-xs text-muted-foreground">PDF · double-click to open</p>
          </div>
        </div>
      )}
      {item.type === "link" && (
        <div className="pointer-events-none flex size-full items-center gap-3 rounded-lg border bg-card px-4 text-card-foreground">
          <Link2 className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{hostOf(item.url)}</p>
            <p className="truncate text-xs text-muted-foreground">{item.url}</p>
          </div>
        </div>
      )}
    </div>
  )
})

function hostOf(url?: string) {
  try {
    return new URL(url ?? "").hostname
  } catch {
    return url ?? ""
  }
}

function Media({ projectId, file, video }: { projectId: string | null; file: string; video: boolean }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    mediaUrl(projectId, file)
      .then((u) => !cancelled && setSrc(u))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [projectId, file])
  if (failed)
    return (
      <div className="pointer-events-none flex size-full items-center justify-center rounded-sm bg-muted text-muted-foreground">
        <ImageOff className="size-6" />
      </div>
    )
  if (!src) return <div className="pointer-events-none size-full rounded-sm bg-muted" />
  return video ? (
    // No play control yet: a video shows its first frame.
    <video src={`${src}#t=0.1`} muted preload="metadata" onError={() => setFailed(true)} className="pointer-events-none size-full rounded-sm object-fill" />
  ) : (
    <img src={src} alt="" draggable={false} onError={() => setFailed(true)} className="pointer-events-none size-full rounded-sm object-fill" />
  )
}

function TextBody({
  item,
  editing,
  onMeasure,
  onFinishEdit,
}: {
  item: Item
  editing: boolean
  onMeasure: (id: string, h: number) => void
  onFinishEdit: (id: string, text: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    onMeasure(item.id, el.offsetHeight)
    // A detached element reports a height of 0, which would shrink the selection box to a line.
    const ro = new ResizeObserver(() => el.isConnected && onMeasure(item.id, el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
    // Editing swaps the element for a different one, so the measuring has to follow it.
  }, [item.id, onMeasure, editing])

  const style: React.CSSProperties = { fontSize: item.fontSize ?? 24, lineHeight: 1.3, minHeight: `${(item.fontSize ?? 24) * 1.3}px` }
  const common = "w-full whitespace-pre-wrap break-words text-foreground"
  if (!editing) {
    return (
      <div ref={box} className={common} style={style}>
        {item.text}
      </div>
    )
  }
  return <TextEditor boxRef={box} item={item} className={common} style={style} onFinish={(t) => onFinishEdit(item.id, t)} />
}

function TextEditor({
  boxRef,
  item,
  className,
  style,
  onFinish,
}: {
  boxRef: React.RefObject<HTMLDivElement | null>
  item: Item
  className: string
  style: React.CSSProperties
  onFinish: (text: string) => void
}) {
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    el.textContent = item.text ?? ""
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    // Only on entering edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      ref={boxRef}
      data-editor
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      className={cn(className, "cursor-text outline-none")}
      style={style}
      onBlur={(e) => onFinish(e.currentTarget.innerText)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") e.currentTarget.blur()
      }}
    />
  )
}

const HIT = 14
const MENU_ITEM = "flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
const ARROW_HEAD = 20

/** A shape: an outline (text colour unless a colour was chosen), and for rectangles and ellipses an optional fill. */
function ShapeBody({ item, selected }: { item: Item; selected: boolean }) {
  const { w, h } = item
  const STROKE = item.stroke ?? DEFAULT_STROKE
  const filled = (item.type === "rect" || item.type === "ellipse") && !!item.fill
  const dash = item.dash === "dashed" ? `${STROKE * 3} ${STROKE * 2}` : item.dash === "dotted" ? `0 ${STROKE * 2}` : undefined
  const common = { fill: filled ? item.fill : "none", strokeLinecap: "round", strokeLinejoin: "round", strokeDasharray: dash } as const
  // Unselected, only the line can be picked up (or, with a fill, anywhere inside). Once selected, anywhere inside can be dragged too.
  const hit = { fill: "none", stroke: "transparent", strokeWidth: Math.max(HIT, STROKE), pointerEvents: selected || filled ? "all" : "stroke", strokeLinecap: "round", strokeLinejoin: "round" } as const
  const ink = item.color ?? "currentColor"
  let d = ""
  let shape: React.ReactNode = null
  if (item.type === "rect" || item.type === "ellipse") {
    const o = STROKE / 2
    const props =
      item.type === "rect"
        ? { as: "rect" as const, x: o, y: o, width: Math.max(0, w - STROKE), height: Math.max(0, h - STROKE), rx: 8 }
        : { as: "ellipse" as const, cx: w / 2, cy: h / 2, rx: Math.max(0, (w - STROKE) / 2), ry: Math.max(0, (h - STROKE) / 2) }
    const { as: Tag, ...rest } = props
    shape = (
      <>
        <Tag {...rest} {...hit} />
        <Tag {...rest} {...common} stroke={ink} strokeWidth={STROKE} />
      </>
    )
  } else {
    const { a, b } = lineEnds({ ...item, x: 0, y: 0 })
    d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`
    if (item.type === "arrow") {
      const angle = Math.atan2(b.y - a.y, b.x - a.x)
      const spread = (28 * Math.PI) / 180
      const head = Math.max(ARROW_HEAD, STROKE * 4)
      const barb = (s: number) => `${b.x - head * Math.cos(angle + s)} ${b.y - head * Math.sin(angle + s)}`
      d += ` M ${barb(spread)} L ${b.x} ${b.y} L ${barb(-spread)}`
    }
    shape = (
      <>
        <path d={d} {...hit} />
        <path d={d} {...common} fill="none" stroke={ink} strokeWidth={STROKE} />
      </>
    )
  }
  return (
    // An SVG with no width or height draws nothing, even with overflow visible, so a flat line gets a 1px box.
    <svg width={Math.max(w, 1)} height={Math.max(h, 1)} className="absolute top-0 left-0 overflow-visible text-foreground" aria-hidden>
      {shape}
    </svg>
  )
}

type StylePatch = Partial<Pick<Item, "color" | "fill" | "stroke" | "dash">>

// Defined here, not inside ShapeStyle: a component made on every render is a new element each time, and a button that is
// replaced between pressing and releasing never gets its click.
function Swatch({ value, current, label, onPick }: { value: string | null; current: string | undefined; label: string; onPick: () => void }) {
  const on = (value ?? undefined) === current
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onPick}
      className={cn(
        "size-6 rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on && "ring-2 ring-primary ring-offset-1 ring-offset-popover",
        value === null && "bg-[linear-gradient(135deg,transparent_45%,var(--color-muted-foreground)_45%,var(--color-muted-foreground)_55%,transparent_55%)]",
      )}
      style={value ? { background: value } : undefined}
    />
  )
}

function Choice({ on, label, onPick }: { on: boolean; label: string; onPick: () => void }) {
  return (
    <Button type="button" size="sm" variant={on ? "secondary" : "ghost"} aria-pressed={on} onClick={onPick} className="min-w-0 flex-1 px-1.5">
      {label}
    </Button>
  )
}

/** Colour, fill, thickness and line style for the selected shapes. Choosing "Default" removes the choice. */
function ShapeStyle({ shapes, onChange }: { shapes: Item[]; onChange: (patch: StylePatch) => void }) {
  const first = shapes[0]
  const canFill = shapes.some((s) => s.type === "rect" || s.type === "ellipse")
  const same = <K extends keyof StylePatch>(k: K) => (shapes.every((s) => s[k] === first[k]) ? first[k] : undefined)
  const color = same("color")
  const fill = same("fill")
  const stroke = same("stroke") ?? (shapes.every((s) => s.stroke === undefined) ? DEFAULT_STROKE : undefined)
  const dash = same("dash")

  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Color and line" title="Color and line" />}>
        <Paintbrush />
      </PopoverTrigger>
      <PopoverContent data-ui align="center" className="w-72 gap-3 p-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Line color</span>
          <div className="flex flex-wrap gap-1.5">
            <Swatch value={null} current={color} label="Default line color" onPick={() => onChange({ color: undefined })} />
            {SHAPE_COLORS.map((c) => (
              <Swatch key={c} value={c} current={color} label={c} onPick={() => onChange({ color: c })} />
            ))}
          </div>
        </div>
        {canFill && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Fill</span>
            <div className="flex flex-wrap gap-1.5">
              <Swatch value={null} current={fill} label="No fill" onPick={() => onChange({ fill: undefined })} />
              {SHAPE_COLORS.map((c) => (
                <Swatch key={c} value={c} current={fill} label={`Fill ${c}`} onPick={() => onChange({ fill: c })} />
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Line thickness</span>
          <div className="flex gap-1">
            {SHAPE_WEIGHTS.map((w) => (
              <Choice key={w.label} label={w.label} on={stroke === w.value} onPick={() => onChange({ stroke: w.value === DEFAULT_STROKE ? undefined : w.value })} />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Line style</span>
          <div className="flex gap-1">
            <Choice label="Solid" on={dash === undefined && shapes.every((s) => !s.dash)} onPick={() => onChange({ dash: undefined })} />
            <Choice label="Dashed" on={dash === "dashed"} onPick={() => onChange({ dash: "dashed" })} />
            <Choice label="Dotted" on={dash === "dotted"} onPick={() => onChange({ dash: "dotted" })} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
