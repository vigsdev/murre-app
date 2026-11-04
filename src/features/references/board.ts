/** The reference board document and the small pure helpers around it. */

// Written into saved boards, so it keeps its original value (it is not shown anywhere). Do not rename it.
export const BOARD_FORMAT = "sequenxe-board"
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 8

export type ItemType = "image" | "video" | "text" | "pdf" | "link" | "rect" | "ellipse" | "line" | "arrow"

export interface Item {
  id: string
  type: ItemType
  x: number
  y: number
  w: number
  /** Text items grow to fit their text, so their stored height is only a hint. */
  h: number
  /** Media file name in the reference media folder (image, video, pdf). */
  file?: string
  /** Original file name, shown on PDF cards. */
  name?: string
  text?: string
  fontSize?: number
  url?: string
  /**
   * Lines and arrows run corner to corner of their box. By default from the top left to the bottom right; these
   * turn either end around. For an arrow the head is at the end.
   */
  flipX?: boolean
  flipY?: boolean
  /** Shapes only: outline colour (`#rrggbb`). Without it a shape uses the text colour. */
  color?: string
  /** Rectangles and ellipses only: fill colour (`#rrggbb`). Without it the inside is empty. */
  fill?: string
  /** Shapes only: outline thickness, in board units. */
  stroke?: number
  /** Shapes only: how the outline is drawn. Without it the outline is solid. */
  dash?: "dashed" | "dotted"
}

/** Colours offered for shapes. The first look of a shape (the text colour) is not in the list: it is "Default". */
export const SHAPE_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#ec4899", "#ffffff", "#000000"] as const
export const SHAPE_WEIGHTS = [
  { label: "Thin", value: 1.5 },
  { label: "Medium", value: 3 },
  { label: "Thick", value: 6 },
  { label: "Heavy", value: 12 },
] as const
export const DEFAULT_STROKE = 3
export const isHexColor = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)

export interface View {
  x: number
  y: number
  zoom: number
}

export interface Board {
  format: typeof BOARD_FORMAT
  version: 1
  /** Bottom to top: later items draw over earlier ones. */
  items: Item[]
  view?: View
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const emptyBoard = (): Board => ({ format: BOARD_FORMAT, version: 1, items: [] })

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
const TYPES: ItemType[] = ["image", "video", "text", "pdf", "link", "rect", "ellipse", "line", "arrow"]

/** Lines and arrows can be perfectly flat, so their box can have no height (or width). */
export const isLine = (i: Pick<Item, "type">) => i.type === "line" || i.type === "arrow"
export const isShape = (i: Pick<Item, "type">) => i.type === "rect" || i.type === "ellipse" || isLine(i)

/** Where a line or arrow starts and ends, in board coordinates. */
export function lineEnds(i: Item): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const ax = i.flipX ? i.x + i.w : i.x
  const ay = i.flipY ? i.y + i.h : i.y
  const bx = i.flipX ? i.x : i.x + i.w
  const by = i.flipY ? i.y : i.y + i.h
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } }
}

/** The box and turned-around flags that put a line between two points. */
export function lineFrom(a: { x: number; y: number }, b: { x: number; y: number }): Pick<Item, "x" | "y" | "w" | "h" | "flipX" | "flipY"> {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), flipX: a.x > b.x, flipY: a.y > b.y }
}

/** Reads a saved board defensively: unknown or broken items are skipped, never thrown on. */
export function parseBoard(raw: unknown): Board | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (r.format !== BOARD_FORMAT || !Array.isArray(r.items)) return null
  const items: Item[] = []
  for (const it of r.items) {
    if (!it || typeof it !== "object") continue
    const o = it as Record<string, unknown>
    if (typeof o.id !== "string" || !TYPES.includes(o.type as ItemType)) continue
    if (!finite(o.x) || !finite(o.y) || !finite(o.w) || !finite(o.h)) continue
    const lineLike = o.type === "line" || o.type === "arrow"
    if (lineLike ? o.w < 0 || o.h < 0 || (o.w === 0 && o.h === 0) : o.w <= 0 || o.h <= 0) continue
    const item: Item = { id: o.id, type: o.type as ItemType, x: o.x, y: o.y, w: o.w, h: o.h }
    if (typeof o.file === "string") item.file = o.file
    if (typeof o.name === "string") item.name = o.name
    if (typeof o.text === "string") item.text = o.text
    if (finite(o.fontSize)) item.fontSize = o.fontSize
    if (typeof o.url === "string") item.url = o.url
    if (o.flipX === true) item.flipX = true
    if (o.flipY === true) item.flipY = true
    if (isHexColor(o.color)) item.color = o.color
    if (isHexColor(o.fill)) item.fill = o.fill
    if (finite(o.stroke) && o.stroke >= 0.5 && o.stroke <= 32) item.stroke = o.stroke
    if (o.dash === "dashed" || o.dash === "dotted") item.dash = o.dash
    items.push(item)
  }
  const v = r.view as Record<string, unknown> | undefined
  const view = v && finite(v.x) && finite(v.y) && finite(v.zoom) ? { x: v.x, y: v.y, zoom: clampZoom(v.zoom) } : undefined
  return { format: BOARD_FORMAT, version: 1, items, view }
}

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/** Only web links are turned into link cards. */
export function normalizeUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

/** Height used for geometry: text is measured on screen, everything else uses its stored size. */
export function itemRect(item: Item, measured: ReadonlyMap<string, number>): Rect {
  const h = item.type === "text" ? (measured.get(item.id) ?? Math.max(item.h, (item.fontSize ?? 24) * 1.3)) : item.h
  return { x: item.x, y: item.y, w: item.w, h }
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** Fits an image or video into a starting size that is easy to work with. */
export function startSize(w: number, h: number, longest = 420): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: longest, h: longest * 0.66 }
  const scale = Math.min(1, longest / Math.max(w, h))
  return { w: Math.max(24, Math.round(w * scale)), h: Math.max(24, Math.round(h * scale)) }
}
