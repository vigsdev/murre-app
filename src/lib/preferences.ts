import { useCallback, useEffect, useSyncExternalStore } from "react"

const FONT_PREVIEW_KEY = "murre.fontPreviews"
const EVENT = "murre:preferences"

function read(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key)
    return v === null ? fallback : v === "1"
  } catch {
    return fallback
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb)
  window.addEventListener("storage", cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener("storage", cb)
  }
}

/** Whether the Fonts tab draws a sample of each font. On by default. */
export function useFontPreviews(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => read(FONT_PREVIEW_KEY, true))
  const set = useCallback((on: boolean) => {
    try {
      window.localStorage.setItem(FONT_PREVIEW_KEY, on ? "1" : "0")
    } catch {
      /* private mode or blocked storage: the change just won't stick */
    }
    window.dispatchEvent(new Event(EVENT))
  }, [])
  return [value, set]
}

const ACCENT_KEY = "murre.accent"
const TRANSLUCENT_KEY = "murre.translucent"

export const ACCENTS = [
  { id: "neutral", label: "Neutral", hue: null },
  { id: "blue", label: "Blue", hue: 255 },
  { id: "violet", label: "Violet", hue: 295 },
  { id: "pink", label: "Pink", hue: 350 },
  { id: "orange", label: "Orange", hue: 55 },
  { id: "green", label: "Green", hue: 150 },
  { id: "teal", label: "Teal", hue: 195 },
] as const
export type AccentId = (typeof ACCENTS)[number]["id"]

function readText(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* blocked storage: the change just won't stick */
  }
  window.dispatchEvent(new Event(EVENT))
}

function readAccent(): AccentId {
  const v = readText(ACCENT_KEY)
  return ACCENTS.some((a) => a.id === v) ? (v as AccentId) : "neutral"
}

/** Colour for buttons, checkmarks and focus rings. Neutral (black and white) by default. */
export function useAccent(): [AccentId, (id: AccentId) => void] {
  const value = useSyncExternalStore(subscribe, readAccent)
  return [value, useCallback((id: AccentId) => write(ACCENT_KEY, id), [])]
}

/** Whether the Mac's blur shows through the sidebar and the window frame. On by default. */
export function useTranslucent(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => read(TRANSLUCENT_KEY, true))
  return [value, useCallback((on: boolean) => write(TRANSLUCENT_KEY, on ? "1" : "0"), [])]
}

/** Puts the saved look on the page. Runs before the first paint and again whenever a choice changes. */
export function applyAppearance() {
  const root = document.documentElement
  const accent = ACCENTS.find((a) => a.id === readAccent())
  if (accent?.hue != null) {
    root.dataset.accent = accent.id
    root.style.setProperty("--accent-h", String(accent.hue))
  } else {
    delete root.dataset.accent
    root.style.removeProperty("--accent-h")
  }
  root.classList.toggle("solid-window", !read(TRANSLUCENT_KEY, true))
}

/** Keeps the page in step with the choices in Settings. */
export function useAppearance() {
  const look = useSyncExternalStore(subscribe, () => `${readAccent()}${read(TRANSLUCENT_KEY, true)}`)
  useEffect(applyAppearance, [look])
}
