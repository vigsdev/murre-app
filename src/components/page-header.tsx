import { cn } from "@/lib/utils"

/**
 * The room a page leaves for the tab strip, for pages with no header of their own. The tab already says which page
 * this is, so these pages carry no title row or line. It is still the window's drag area.
 */
export function PageTop() {
  return <div data-tauri-drag-region className="h-(--tabstrip-h) shrink-0" />
}

/**
 * `hero` is for a page whose name is the page: the name is drawn large, in a taller strip, with no line under it.
 * `start` and `end` make a title-less toolbar strip instead: controls on the left, controls on the right.
 * Every kind is still the window's drag area. The tab strip floats over the top of the page, so each header starts
 * below it (`--tabstrip-h`); the sidebar button lives in the strip.
 */
export function PageHeader({
  title,
  actions,
  hero,
  start,
  end,
  titleClassName,
  titleNode,
}: {
  title: string
  actions?: React.ReactNode
  hero?: boolean
  start?: React.ReactNode
  end?: React.ReactNode
  /** Replaces the large title's size, for pages whose title is a sentence. */
  titleClassName?: string
  /** Replaces the title with an editable one. It should be the same size as the text it replaces. */
  titleNode?: React.ReactNode
}) {
  const toolbar = start !== undefined || end !== undefined
  return (
    <header
      data-tauri-drag-region
      className={cn("box-content flex shrink-0 items-center gap-2 px-4 pt-(--tabstrip-h)", hero ? "relative h-16 px-6" : toolbar ? "h-14 px-6" : "h-12 border-b")}
    >
      {toolbar ? (
        <>
          {start && <div className="flex min-w-0 items-center gap-2">{start}</div>}
          {end && <div className="ml-auto flex shrink-0 items-center gap-2">{end}</div>}
        </>
      ) : (
        <>
          {titleNode ? (
            <h1 className="min-w-0 flex-1">{titleNode}</h1>
          ) : (
          <h1 title={title} className={cn("min-w-0 truncate", hero ? "text-3xl font-semibold tracking-tight" : "text-sm font-medium", titleClassName)}>
            {title}
          </h1>
          )}
          {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
        </>
      )}
    </header>
  )
}
