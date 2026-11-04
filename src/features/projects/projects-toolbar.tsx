import { ArrowUpDown, ListFilter, Search, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  DEFAULT_QUERY,
  PRIORITY_FILTER_OPTIONS,
  SORT_OPTIONS,
  STATUS_FILTER_OPTIONS,
  type ListQuery,
} from "./project-utils"

/** Search, filter and sort as three compact controls on the right, instead of a row of wide fields. */
export function ProjectsToolbar({ query, onChange }: { query: ListQuery; onChange: (q: ListQuery) => void }) {
  const [searchOpen, setSearchOpen] = useState(query.search !== "")
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchOpen) input.current?.focus()
  }, [searchOpen])

  const filtered = query.status !== DEFAULT_QUERY.status || query.priority !== DEFAULT_QUERY.priority

  function closeSearch() {
    setSearchOpen(false)
    onChange({ ...query, search: "" })
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {searchOpen ? (
        <div className="relative w-64 max-w-full">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={input}
            aria-label="Search projects"
            placeholder="Search name, client or description"
            className="pr-8 pl-8"
            value={query.search}
            onChange={(e) => onChange({ ...query, search: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && closeSearch()}
          />
          <button
            type="button"
            aria-label="Close search"
            onClick={closeSearch}
            className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <Button variant="outline" size="icon" aria-label="Search projects" onClick={() => setSearchOpen(true)}>
          <Search />
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="Filter projects" className="relative" />}>
          <ListFilter />
          {filtered && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" aria-hidden />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Status</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={query.status} onValueChange={(v) => v && onChange({ ...query, status: v as ListQuery["status"] })}>
              {STATUS_FILTER_OPTIONS.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick>
                  {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Priority</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={query.priority} onValueChange={(v) => v && onChange({ ...query, priority: v as ListQuery["priority"] })}>
              {PRIORITY_FILTER_OPTIONS.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick>
                  {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="Sort projects" />}>
          <ArrowUpDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={query.sort} onValueChange={(v) => v && onChange({ ...query, sort: v as ListQuery["sort"] })}>
              {SORT_OPTIONS.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick>
                  {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
