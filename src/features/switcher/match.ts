// Matching for the switcher. Plain functions, no React.

export interface Match {
  score: number
  /** Positions in the text that matched, for highlighting. */
  indices: number[]
}

/**
 * Letters of `query` must appear in `text` in order (case ignored). Earlier, consecutive and word-start matches
 * score higher; null when it does not match at all.
 */
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, indices: [] }
  const t = text.toLowerCase()
  // An exact run is the best match there is.
  const at = t.indexOf(q)
  if (at !== -1) {
    const start = at === 0 || /[\s\-_/·]/.test(t[at - 1])
    return { score: 1000 - at + (start ? 200 : 0) + (t.length === q.length ? 300 : 0), indices: range(at, q.length) }
  }
  const indices: number[] = []
  let score = 0
  let from = 0
  let prev = -2
  for (const ch of q) {
    if (ch === " ") continue
    const i = t.indexOf(ch, from)
    if (i === -1) return null
    indices.push(i)
    score += 10
    if (i === prev + 1) score += 15
    if (i === 0 || /[\s\-_/·]/.test(t[i - 1])) score += 12
    score -= Math.min(i - from, 8)
    prev = i
    from = i + 1
  }
  return { score, indices }
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i)
}

export interface Searchable {
  /** What the match runs against, shown as the main line. */
  label: string
  /** Extra words that also match, shown muted (a project's client, say). */
  hint?: string
}

export interface Ranked<T> {
  item: T
  /** Highlight positions in the label. */
  indices: number[]
  score: number
}

/** Items that match `query`, best first. Ties keep their original order. An empty query keeps everything as it was. */
export function rank<T extends Searchable>(query: string, items: T[], limit = 40): Ranked<T>[] {
  const out: (Ranked<T> & { order: number })[] = []
  items.forEach((item, order) => {
    const byLabel = fuzzyMatch(query, item.label)
    if (byLabel) return void out.push({ item, indices: byLabel.indices, score: byLabel.score + 50, order })
    const byHint = item.hint ? fuzzyMatch(query, item.hint) : null
    if (byHint) out.push({ item, indices: [], score: byHint.score, order })
  })
  if (query.trim()) out.sort((a, b) => b.score - a.score || a.order - b.order)
  return out.slice(0, limit)
}
