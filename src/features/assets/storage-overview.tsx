import { formatBytes } from "@/lib/format"
import type { StorageView } from "@/lib/tauri"
import { KIND_COLOR, KIND_LABEL } from "./asset-kinds"

/** How much space the project takes, split by kind of file, as one bar with a legend under it. */
export function StorageOverview({ storage }: { storage: StorageView }) {
  const { total, kinds } = storage
  return (
    <section aria-label="Storage" className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Storage</h3>
        <p className="text-sm text-muted-foreground tabular-nums">
          {storage.truncated && "At least "}
          <span className="text-foreground">{formatBytes(total.bytes)}</span> in {total.files.toLocaleString()} {total.files === 1 ? "file" : "files"}
        </p>
      </div>
      {total.bytes > 0 ? (
        <>
          <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={kinds.map((k) => `${KIND_LABEL[k.kind]} ${formatBytes(k.bytes)}`).join(", ")}>
            {kinds.map((k) => (
              <div
                key={k.kind}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{ width: `${Math.max(0.5, (k.bytes / total.bytes) * 100)}%`, background: KIND_COLOR[k.kind] }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
            {kinds.map((k) => (
              <li key={k.kind} className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full" style={{ background: KIND_COLOR[k.kind] }} />
                <span className="text-muted-foreground">{KIND_LABEL[k.kind]}</span>
                <span className="tabular-nums">{formatBytes(k.bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No files yet. Everything starts somewhere.</p>
      )}
    </section>
  )
}
