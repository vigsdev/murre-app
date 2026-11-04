import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

interface Pkg {
  n: string
  v: string
  l: string
  u?: string
  c?: string
  k: "web" | "native"
}

/** The names thanked on the page. The full list, with licences, is behind "View licenses". */
const THANKED = [
  { name: "Tauri", url: "https://tauri.app" },
  { name: "React", url: "https://react.dev" },
  { name: "Tailwind CSS", url: "https://tailwindcss.com" },
  { name: "Base UI", url: "https://base-ui.com" },
  { name: "Tiptap", url: "https://tiptap.dev" },
  { name: "dnd kit", url: "https://dndkit.com" },
  { name: "Motion", url: "https://motion.dev" },
  { name: "Shiki", url: "https://shiki.style" },
  { name: "Lucide", url: "https://lucide.dev" },
  { name: "SQLite", url: "https://sqlite.org" },
  { name: "Inter", url: "https://rsms.me/inter" },
]

/** A quiet thank-you at the very end of Settings, with the licence list for anyone who wants it. */
export function Credits() {
  const [open, setOpen] = useState(false)
  return (
    <footer className="flex flex-col gap-2 pb-2 text-xs text-muted-foreground">
      <p className="leading-relaxed">
        Murre stands on a lot of open-source work. Thank you to the people behind{" "}
        {THANKED.map((t, i) => (
          <span key={t.name}>
            <button type="button" onClick={() => void openUrl(t.url)} className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
              {t.name}
            </button>
            {i < THANKED.length - 2 ? ", " : i === THANKED.length - 2 ? " and " : ""}
          </span>
        ))}
        , and to the hundreds of packages under them.
      </p>
      <p>
        <button type="button" onClick={() => setOpen(true)} className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
          View licenses
        </button>
      </p>
      <p className="pt-2">Made possible with a little help from Claude and ChatGPT.</p>
      <p>
        Built with <span aria-label="love">♡</span> by{" "}
        <button type="button" onClick={() => void openUrl("https://vigs.dev")} className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          Vigs
        </button>{" "}
        from Chennai, India.
      </p>
      <LicenseSheet open={open} onOpenChange={setOpen} />
    </footer>
  )
}

function LicenseSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [all, setAll] = useState<Pkg[] | null>(null)
  const [query, setQuery] = useState("")

  // The list is large and only read here, so it is loaded the first time the sheet opens.
  useEffect(() => {
    if (open && !all) void import("@/assets/credits.json").then((m) => setAll(m.default as Pkg[]))
  }, [open, all])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (all ?? []).filter((p) => !q || p.n.toLowerCase().includes(q) || p.l.toLowerCase().includes(q))
  }, [all, query])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Licenses</SheetTitle>
          <SheetDescription>
            {all ? `${all.length} packages are part of Murre.` : "Loading…"} Inter is used under the SIL Open Font License 1.1. Adobe product names and
            icons belong to Adobe, and Murre isn’t affiliated with Adobe.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-3">
          <Input autoComplete="off" placeholder="Search by name or license" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search packages" />
        </div>
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto border-t">
          {shown.map((p) => (
            <li key={`${p.k}-${p.n}-${p.v}`} className="px-4 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                {p.u ? (
                  <button type="button" onClick={() => void openUrl(p.u!)} className="min-w-0 truncate text-left text-sm font-medium outline-none hover:underline focus-visible:underline">
                    {p.n}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-sm font-medium">{p.n}</span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">{p.v}</span>
              </div>
              <p className="text-xs text-muted-foreground">{p.l}</p>
              {p.c && <p className="mt-0.5 text-xs text-muted-foreground/80">{p.c}</p>}
            </li>
          ))}
          {all && shown.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing matches that.</li>}
        </ul>
      </SheetContent>
    </Sheet>
  )
}
