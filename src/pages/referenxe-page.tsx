import { lazy, Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"

// The board code is loaded only when this page is first opened.
const ReferencesTab = lazy(() => import("@/features/projects/detail/references-tab").then((m) => ({ default: m.ReferencesTab })))

/** App-wide reference board, stored in the application data folder (not in any project). It uses the whole page. */
export function ReferenxePage() {
  return (
    <div className="fit-page relative flex flex-col pt-(--tabstrip-h)">
      <Suspense fallback={<Skeleton className="min-h-96 flex-1" />}>
        <ReferencesTab projectId={null} fill />
      </Suspense>
    </div>
  )
}
