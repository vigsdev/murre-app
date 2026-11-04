// The rules behind the tab strip. Plain functions, no React: what a navigation does to the tabs, what closing one
// does, and what gets restored. The strip itself lives in tab-strip.tsx.
//
// The rules, in one place:
//  - A tab is a page. Going to a page that is already open takes you to its tab.
//  - Otherwise the page replaces the tab you are on, unless that tab is a project: project tabs stay put, so the
//    page opens in a new tab next to it.
//  - Cmd-click, middle-click and + always make a new tab.

export interface Tab {
  id: string
  /** The route, such as `/projects/abc`. */
  path: string
}

export interface TabsState {
  tabs: Tab[]
  activeId: string
}

export const HOME = "/"
export const MAX_TABS = 24

export type NewId = () => string

export function newTabId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10)
}

export function normalizePath(path: string): string {
  const clean = path.split(/[?#]/)[0] || "/"
  const trimmed = clean.length > 1 ? clean.replace(/\/+$/, "") : clean
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

/** `/projects/:id` (not `/projects/new`). */
export function projectIdOf(path: string): string | null {
  const m = /^\/projects\/([^/]+)$/.exec(path)
  return m && m[1] !== "new" ? m[1] : null
}

export function spaceIdOf(path: string): string | null {
  const m = /^\/spaces\/([^/]+)$/.exec(path)
  return m ? m[1] : null
}

export const isProjectPath = (path: string) => projectIdOf(path) !== null

const activeOf = (s: TabsState): Tab | undefined => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]

/** Reads saved tabs defensively; anything unreadable is ignored. */
export function parseStored(raw: unknown): TabsState | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as { tabs?: unknown; activeId?: unknown }
  if (!Array.isArray(r.tabs)) return null
  const seen = new Set<string>()
  const tabs: Tab[] = []
  for (const t of r.tabs) {
    if (!t || typeof t !== "object") continue
    const { id, path } = t as { id?: unknown; path?: unknown }
    if (typeof id !== "string" || typeof path !== "string" || !path.startsWith("/") || path.length > 300 || seen.has(id)) continue
    seen.add(id)
    tabs.push({ id, path: normalizePath(path) })
    if (tabs.length >= MAX_TABS) break
  }
  if (tabs.length === 0) return null
  const activeId = typeof r.activeId === "string" && seen.has(r.activeId) ? r.activeId : tabs[0].id
  return { tabs, activeId }
}

/** The tabs at start-up: what was saved (if anything), then the page the app opened on. */
export function initState(stored: TabsState | null, path: string, mkId: NewId = newTabId): TabsState {
  const here = normalizePath(path)
  if (!stored) {
    const id = mkId()
    return { tabs: [{ id, path: here }], activeId: id }
  }
  return reconcile(stored, here, mkId)
}

/** The router moved to `path` by itself (a link, back or forward): make the tabs agree. */
export function reconcile(s: TabsState, path: string, mkId: NewId = newTabId): TabsState {
  const here = normalizePath(path)
  const active = activeOf(s)
  if (!active) {
    const id = mkId()
    return { tabs: [{ id, path: here }], activeId: id }
  }
  if (active.path === here) return s.activeId === active.id ? s : { ...s, activeId: active.id }
  const existing = s.tabs.find((t) => t.path === here)
  if (existing) return { ...s, activeId: existing.id }
  if (isProjectPath(active.path) && s.tabs.length < MAX_TABS) {
    const id = mkId()
    const at = s.tabs.indexOf(active) + 1
    return { tabs: [...s.tabs.slice(0, at), { id, path: here }, ...s.tabs.slice(at)], activeId: id }
  }
  return { ...s, tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, path: here } : t)) }
}

/** A new tab right after the current one, even if the page is open already. */
export function openInNewTab(s: TabsState, path: string, mkId: NewId = newTabId): TabsState {
  const here = normalizePath(path)
  if (s.tabs.length >= MAX_TABS) return reconcile(s, here, mkId)
  const active = activeOf(s)
  const id = mkId()
  const at = active ? s.tabs.indexOf(active) + 1 : s.tabs.length
  return { tabs: [...s.tabs.slice(0, at), { id, path: here }, ...s.tabs.slice(at)], activeId: id }
}

export function activate(s: TabsState, id: string): TabsState {
  return s.tabs.some((t) => t.id === id) ? { ...s, activeId: id } : s
}

export interface Change {
  state: TabsState
  /** Where the router has to go now, if the page on screen changed. */
  goTo: string | null
}

/** Closing the last tab leaves one tab on Home, so the strip is never empty. */
export function closeTab(s: TabsState, id: string): Change {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i < 0) return { state: s, goTo: null }
  if (s.tabs.length === 1) {
    const only = s.tabs[0]
    return { state: { tabs: [{ ...only, path: HOME }], activeId: only.id }, goTo: only.path === HOME ? null : HOME }
  }
  const tabs = s.tabs.filter((t) => t.id !== id)
  if (id !== s.activeId) return { state: { tabs, activeId: s.activeId }, goTo: null }
  const next = tabs[Math.min(i, tabs.length - 1)]
  return { state: { tabs, activeId: next.id }, goTo: next.path }
}

/** Drops project tabs whose project is gone. */
export function pruneProjects(s: TabsState, exists: (projectId: string) => boolean): Change {
  const tabs = s.tabs.filter((t) => {
    const p = projectIdOf(t.path)
    return p === null || exists(p)
  })
  if (tabs.length === s.tabs.length) return { state: s, goTo: null }
  if (tabs.length === 0) {
    const id = s.tabs[0].id
    return { state: { tabs: [{ id, path: HOME }], activeId: id }, goTo: HOME }
  }
  if (tabs.some((t) => t.id === s.activeId)) return { state: { tabs, activeId: s.activeId }, goTo: null }
  const was = s.tabs.findIndex((t) => t.id === s.activeId)
  const next = tabs[Math.min(Math.max(was, 0), tabs.length - 1)]
  return { state: { tabs, activeId: next.id }, goTo: next.path }
}

const FIXED_TITLES: Record<string, string> = {
  "/": "Home",
  "/projects": "Projects",
  "/projects/new": "New project",
  "/notes": "Notes",
  "/calendar": "Calendar",
  "/referenxe": "Referenxe",
  "/settings": "Settings",
}

export function tabTitle(path: string, names: { project: (id: string) => string | undefined; space: (id: string) => string | undefined }): string {
  const fixed = FIXED_TITLES[path]
  if (fixed) return fixed
  const p = projectIdOf(path)
  if (p) return names.project(p) ?? "Project"
  const sp = spaceIdOf(path)
  if (sp) return names.space(sp) ?? "Space"
  return "Page"
}
