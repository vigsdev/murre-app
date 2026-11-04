import { BOARD_FORMAT, newId, type Board, type Item } from "./board"

// Found inside older saved boards, so it keeps its original value. Do not rename it.
const REF_SCHEME = "asset:sequenxe-ref/"
const FONT_SIZES: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v)
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)

/** Plain text from a tldraw rich-text (ProseMirror) document, one line per paragraph. */
export function richTextToPlain(doc: unknown): string {
  const lines: string[] = []
  const walk = (node: unknown, line: string[]) => {
    if (!isRec(node)) return
    if (typeof node.text === "string") line.push(node.text)
    if (node.type === "hardBreak") line.push("\n")
    const kids = Array.isArray(node.content) ? node.content : []
    const block = node.type === "paragraph" || node.type === "heading" || node.type === "listItem"
    const target = block ? [] : line
    for (const k of kids) walk(k, target)
    if (block) lines.push(target.join(""))
  }
  walk(doc, [])
  return lines.join("\n").trim()
}

export const isTldrawCanvas = (c: unknown): boolean => isRec(c) && isRec(c.store) && isRec(c.schema)

/**
 * Converts a saved tldraw board into a Murre board. Images, videos, text, PDF cards and links are carried over;
 * drawings, arrows, shapes and anything else cannot be, and are counted in `dropped`.
 */
export function migrateTldraw(canvas: unknown): { board: Board; dropped: number } {
  const store = isRec(canvas) && isRec(canvas.store) ? canvas.store : {}
  const assets = new Map<string, Rec>()
  const shapes: Rec[] = []
  for (const rec of Object.values(store)) {
    if (!isRec(rec)) continue
    if (rec.typeName === "asset") assets.set(String(rec.id), rec)
    else if (rec.typeName === "shape") shapes.push(rec)
  }
  // Stacking order in tldraw is the fractional `index` string (plain string comparison is the intended order).
  shapes.sort((a, b) => (String(a.index ?? "") < String(b.index ?? "") ? -1 : String(a.index ?? "") > String(b.index ?? "") ? 1 : 0))

  const items: Item[] = []
  let dropped = 0
  for (const s of shapes) {
    const props = isRec(s.props) ? s.props : {}
    const meta = isRec(s.meta) ? s.meta : {}
    const x = num(s.x, 0)
    const y = num(s.y, 0)
    const asset = typeof props.assetId === "string" ? assets.get(props.assetId) : undefined
    const aprops = asset && isRec(asset.props) ? asset.props : {}
    const src = typeof aprops.src === "string" ? aprops.src : ""

    if ((s.type === "image" || s.type === "video") && src.startsWith(REF_SCHEME)) {
      items.push({
        id: newId(),
        type: s.type,
        x,
        y,
        w: Math.max(8, num(props.w, 320)),
        h: Math.max(8, num(props.h, 240)),
        file: src.slice(REF_SCHEME.length),
      })
    } else if (s.type === "text") {
      const text = richTextToPlain(props.richText) || (typeof props.text === "string" ? props.text.trim() : "")
      if (!text) continue
      const scale = num(props.scale, 1)
      const size = (FONT_SIZES[String(props.size)] ?? 24) * scale
      items.push({
        id: newId(),
        type: "text",
        x,
        y,
        w: Math.max(40, num(props.w, 240) * scale),
        h: size * 1.4,
        text,
        fontSize: size,
      })
    } else if (s.type === "geo" && meta.referenceType === "pdf" && typeof meta.referenceFile === "string") {
      items.push({
        id: newId(),
        type: "pdf",
        x,
        y,
        w: 260,
        h: 72,
        file: meta.referenceFile,
        name: typeof meta.originalName === "string" ? meta.originalName : "PDF",
      })
    } else if (s.type === "bookmark" && typeof aprops.src === "string" && /^https?:/i.test(aprops.src)) {
      items.push({ id: newId(), type: "link", x, y, w: 280, h: 72, url: aprops.src })
    } else {
      dropped += 1
    }
  }
  return { board: { format: BOARD_FORMAT, version: 1, items }, dropped }
}
