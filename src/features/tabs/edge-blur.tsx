import { useEffect, useState } from "react"
import { useLocation } from "react-router"
import { cn } from "@/lib/utils"

/** Whether the page has been scrolled down at all. */
function useScrolled() {
  const [scrolled, setScrolled] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => {
    // The page card scrolls, not the window.
    const box = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')
    if (!box) return
    const read = () => setScrolled(box.scrollTop > 4)
    read()
    box.addEventListener("scroll", read, { passive: true })
    return () => box.removeEventListener("scroll", read)
  }, [pathname])
  return scrolled
}

const FADE_DOWN = "linear-gradient(to bottom, black 35%, transparent)"

/**
 * A soft blur under the tab strip once the page has scrolled: a few pixels of backdrop blur, faded out with a mask, so
 * text dissolves instead of being cut off. Takes no room and ignores the pointer.
 */
export function TopBlur() {
  const scrolled = useScrolled()
  return (
    <div aria-hidden className="pointer-events-none sticky top-0 z-30 h-0 shrink-0">
      <div
        className={cn(
          "absolute inset-x-0 top-0 h-24 rounded-t-2xl bg-gradient-to-b from-background/80 to-transparent backdrop-blur-[3px] transition-opacity duration-200",
          scrolled ? "opacity-100" : "opacity-0",
        )}
        style={{ maskImage: FADE_DOWN, WebkitMaskImage: FADE_DOWN }}
      />
    </div>
  )
}
