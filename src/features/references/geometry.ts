import { itemRect, unionRect, type Item, type Rect } from "./board"

export type Measured = ReadonlyMap<string, number>

export interface Guide {
  axis: "x" | "y"
  /** Position on that axis in board coordinates. */
  at: number
  from: number
  to: number
}

/**
 * Snaps a moving rectangle's edges and centre to the edges and centres of the other items.
 * `threshold` is in board units (screen pixels divided by the zoom).
 */
export function snapMove(moving: Rect, others: Rect[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [moving.x, moving.x + moving.w / 2, moving.x + moving.w]
  const ys = [moving.y, moving.y + moving.h / 2, moving.y + moving.h]
  let bestX: { d: number; at: number } | null = null
  let bestY: { d: number; at: number } | null = null
  for (const o of others) {
    const oxs = [o.x, o.x + o.w / 2, o.x + o.w]
    const oys = [o.y, o.y + o.h / 2, o.y + o.h]
    for (const a of xs)
      for (const b of oxs) {
        const d = b - a
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: b }
      }
    for (const a of ys)
      for (const b of oys) {
        const d = b - a
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: b }
      }
  }
  const dx = bestX?.d ?? 0
  const dy = bestY?.d ?? 0
  const snapped = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h }
  const guides: Guide[] = []
  if (bestX) {
    const at = bestX.at
    const hit = others.filter((o) => [o.x, o.x + o.w / 2, o.x + o.w].some((v) => Math.abs(v - at) < 0.01))
    const u = unionRect([snapped, ...hit])!
    guides.push({ axis: "x", at, from: u.y, to: u.y + u.h })
  }
  if (bestY) {
    const at = bestY.at
    const hit = others.filter((o) => [o.y, o.y + o.h / 2, o.y + o.h].some((v) => Math.abs(v - at) < 0.01))
    const u = unionRect([snapped, ...hit])!
    guides.push({ axis: "y", at, from: u.x, to: u.x + u.w })
  }
  return { dx, dy, guides }
}

export type Corner = "nw" | "ne" | "sw" | "se"

/** The corner of `r` opposite to the one being dragged: it stays put while resizing. */
export function anchorFor(r: Rect, corner: Corner): { x: number; y: number } {
  return { x: corner.includes("w") ? r.x + r.w : r.x, y: corner.includes("n") ? r.y + r.h : r.y }
}

/**
 * Scales items about an anchor by one factor (so proportions never change). Text scales its font size and width.
 * Rects are measured from the *original* items, so repeated calls during a drag do not accumulate error.
 */
export function scaleItems(originals: Item[], anchor: { x: number; y: number }, factor: number): Item[] {
  return originals.map((it) => {
    const next: Item = {
      ...it,
      x: anchor.x + (it.x - anchor.x) * factor,
      y: anchor.y + (it.y - anchor.y) * factor,
      w: it.w * factor,
      h: it.h * factor,
    }
    if (it.type === "text") next.fontSize = Math.max(6, (it.fontSize ?? 24) * factor)
    return next
  })
}

/** Factor that makes `orig` follow the pointer at the dragged corner, keeping its proportions. */
export function resizeFactor(orig: Rect, corner: Corner, pointer: { x: number; y: number }, minSize = 16): number {
  const anchor = anchorFor(orig, corner)
  const sx = (corner.includes("w") ? anchor.x - pointer.x : pointer.x - anchor.x) / orig.w
  const sy = (corner.includes("n") ? anchor.y - pointer.y : pointer.y - anchor.y) / orig.h
  // Follow whichever axis the pointer has moved further along.
  const f = Math.max(sx, sy)
  return Math.max(f, minSize / Math.min(orig.w, orig.h))
}

export type AlignKind = "left" | "center" | "right" | "top" | "middle" | "bottom"

export function alignItems(items: Item[], ids: ReadonlySet<string>, kind: AlignKind, measured: Measured): Item[] {
  const sel = items.filter((i) => ids.has(i.id))
  const u = unionRect(sel.map((i) => itemRect(i, measured)))
  if (!u || sel.length < 2) return items
  return items.map((it) => {
    if (!ids.has(it.id)) return it
    const r = itemRect(it, measured)
    switch (kind) {
      case "left":
        return { ...it, x: u.x }
      case "center":
        return { ...it, x: u.x + (u.w - r.w) / 2 }
      case "right":
        return { ...it, x: u.x + u.w - r.w }
      case "top":
        return { ...it, y: u.y }
      case "middle":
        return { ...it, y: u.y + (u.h - r.h) / 2 }
      case "bottom":
        return { ...it, y: u.y + u.h - r.h }
    }
  })
}

/** Evens out the gaps between three or more items along one axis; the outermost two stay where they are. */
export function distributeItems(items: Item[], ids: ReadonlySet<string>, axis: "x" | "y", measured: Measured): Item[] {
  const sel = items.filter((i) => ids.has(i.id))
  if (sel.length < 3) return items
  const size = (i: Item) => (axis === "x" ? itemRect(i, measured).w : itemRect(i, measured).h)
  const sorted = [...sel].sort((a, b) => a[axis] - b[axis])
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = last[axis] + size(last) - first[axis]
  const gap = (span - sorted.reduce((n, i) => n + size(i), 0)) / (sorted.length - 1)
  const pos = new Map<string, number>()
  let cursor = first[axis]
  for (const it of sorted) {
    pos.set(it.id, cursor)
    cursor += size(it) + gap
  }
  return items.map((it) => (pos.has(it.id) ? { ...it, [axis]: pos.get(it.id)! } : it))
}

/** Moves the selection one step in the stacking order (or to the very front/back). Relative order is kept. */
export function reorder(items: Item[], ids: ReadonlySet<string>, to: "front" | "back" | "forward" | "backward"): Item[] {
  const picked = items.filter((i) => ids.has(i.id))
  const rest = items.filter((i) => !ids.has(i.id))
  if (picked.length === 0 || rest.length === 0) return items
  if (to === "front") return [...rest, ...picked]
  if (to === "back") return [...picked, ...rest]
  const out = [...items]
  if (to === "forward") {
    for (let i = out.length - 2; i >= 0; i--) {
      if (ids.has(out[i].id) && !ids.has(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]]
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (ids.has(out[i].id) && !ids.has(out[i - 1].id)) [out[i], out[i - 1]] = [out[i - 1], out[i]]
    }
  }
  return out
}
