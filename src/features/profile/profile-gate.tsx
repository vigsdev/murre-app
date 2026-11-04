import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { OnboardingPage } from "./onboarding-page"
import { useProfileContext } from "./profile-context"

/** First launch shows onboarding; afterwards the app opens directly. */
export function ProfileGate({ children }: { children: ReactNode }) {
  const { state, reload } = useProfileContext()

  if (state.status === "loading") {
    return (
      <div
        className="solid-screen flex min-h-svh flex-col items-center justify-center gap-2"
        data-tauri-drag-region
        role="status"
      >
        <h1 className="text-3xl font-semibold tracking-tight">Murre</h1>
        <p className="text-sm text-muted-foreground">Getting your nest ready…</p>
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <main className="solid-screen flex min-h-svh p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Having trouble loading your profile. Try again.</EmptyTitle>
            <EmptyDescription role="alert">{state.message}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </Empty>
      </main>
    )
  }

  return state.profile ? <>{children}</> : <OnboardingPage />
}
