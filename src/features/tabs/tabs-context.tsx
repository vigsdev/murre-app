import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router"
import { useProjectsChanged } from "@/features/sync/sync-context"
import { useSpaces } from "@/features/spaces/spaces-context"
import { api, type ProjectRecord } from "@/lib/tauri"
import {
  activate,
  closeTab,
  initState,
  openInNewTab,
  parseStored,
  projectIdOf,
  pruneProjects,
  reconcile,
  tabTitle,
  type Tab,
  type TabsState,
} from "./tab-state"

const KEY = "murre.tabs"

function readStored(): TabsState | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? parseStored(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

interface TabsValue {
  tabs: Tab[]
  activeId: string
  title: (tab: Tab) => string
  /** Status of the project a tab shows, to colour its dot. */
  projectOf: (tab: Tab) => ProjectRecord | undefined
  select: (id: string) => void
  close: (id: string) => void
  /** A new tab on `path` (Home when left out). */
  openNew: (path?: string) => void
  back: () => void
  forward: () => void
  canBack: boolean
  canForward: boolean
}

const TabsContext = createContext<TabsValue | null>(null)

export function useTabs() {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error("useTabs must be used inside TabsProvider")
  return ctx
}

/** Where the router's history is: its position, and the furthest forward it has been. */
function useHistoryReach() {
  const location = useLocation()
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
  const [max, setMax] = useState(idx)
  useEffect(() => {
    setMax((m) => (idx > m ? idx : m))
  }, [idx, location.key])
  // A new page (not back or forward) throws away what was ahead.
  const reach = useRef(idx)
  useEffect(() => {
    if (idx > reach.current) setMax(idx)
    reach.current = idx
  }, [idx])
  return { canBack: idx > 0, canForward: idx < max }
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { spaces } = useSpaces()
  const [state, setState] = useState<TabsState>(() => initState(readStored(), location.pathname))
  const stateRef = useRef(state)
  stateRef.current = state

  // The router moved on its own (a link, back or forward): the tabs follow.
  useEffect(() => {
    setState((s) => reconcile(s, location.pathname))
  }, [location.pathname])

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      // Not remembering the tabs is fine.
    }
  }, [state])

  // Project names and colours for the tabs; also tells which projects are gone.
  const [projects, setProjects] = useState<Map<string, ProjectRecord> | null>(null)
  const refreshProjects = useCallback(() => {
    api
      .listProjects()
      .then((list) => setProjects(new Map(list.map((p) => [p.id, p]))))
      .catch(() => {})
  }, [])
  useEffect(refreshProjects, [refreshProjects, location.pathname])
  useProjectsChanged(refreshProjects)
  useEffect(() => {
    window.addEventListener("focus", refreshProjects)
    return () => window.removeEventListener("focus", refreshProjects)
  }, [refreshProjects])

  useEffect(() => {
    if (!projects) return
    const change = pruneProjects(stateRef.current, (id) => projects.has(id))
    if (change.state === stateRef.current) return
    setState(change.state)
    if (change.goTo) navigate(change.goTo, { replace: true })
  }, [projects, navigate])

  const select = useCallback(
    (id: string) => {
      const tab = stateRef.current.tabs.find((t) => t.id === id)
      if (!tab) return
      setState((s) => activate(s, id))
      navigate(tab.path)
    },
    [navigate],
  )

  const close = useCallback(
    (id: string) => {
      const change = closeTab(stateRef.current, id)
      setState(change.state)
      if (change.goTo) navigate(change.goTo)
    },
    [navigate],
  )

  const openNew = useCallback(
    (path = "/") => {
      setState((s) => openInNewTab(s, path))
      navigate(path)
    },
    [navigate],
  )

  // Cmd-click or middle-click on any link inside the app opens it in a new tab.
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      const wanted = e.type === "auxclick" ? e.button === 1 : e.metaKey || e.ctrlKey
      if (!wanted) return
      const href = (e.target as Element | null)?.closest?.("a[href]")?.getAttribute("href")
      if (!href || !href.startsWith("#/")) return
      e.preventDefault()
      e.stopPropagation()
      openNew(href.slice(1))
    }
    document.addEventListener("click", handle, true)
    document.addEventListener("auxclick", handle, true)
    return () => {
      document.removeEventListener("click", handle, true)
      document.removeEventListener("auxclick", handle, true)
    }
  }, [openNew])

  const { canBack, canForward } = useHistoryReach()
  const spaceNames = useMemo(() => new Map(spaces.map((s) => [s.id, s.name])), [spaces])

  const value = useMemo<TabsValue>(
    () => ({
      tabs: state.tabs,
      activeId: state.activeId,
      title: (tab) => tabTitle(tab.path, { project: (id) => projects?.get(id)?.name, space: (id) => spaceNames.get(id) }),
      projectOf: (tab) => {
        const id = projectIdOf(tab.path)
        return id ? projects?.get(id) : undefined
      },
      select,
      close,
      openNew,
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      canBack,
      canForward,
    }),
    [state, projects, spaceNames, select, close, openNew, canBack, canForward],
  )

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>
}
