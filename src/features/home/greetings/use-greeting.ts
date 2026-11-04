import { useEffect, useRef, useState } from "react"
import { useCompanionStatus } from "@/features/companion/use-companion-status"
import { api, type ProjectRecord } from "@/lib/tauri"
import { chooseGreeting, parseState } from "./greetings"

/**
 * Home's greeting. It is worked out once when Home opens (the saved choice for today is reused all day) and saved,
 * so going back and forth between pages never changes it. `null` until it is ready, so the page never flashes a
 * different line first.
 */
export function useGreeting(name: string, projects: ProjectRecord[] | null): string | null {
  const { status, ready } = useCompanionStatus()
  const [text, setText] = useState<string | null>(null)
  const done = useRef(false)

  useEffect(() => {
    if (done.current || !projects || !ready) return
    done.current = true
    void (async () => {
      const state = parseState(await api.getGreetingState().catch(() => null))
      const result = chooseGreeting({
        now: new Date(),
        name,
        projects: projects.map((p) => ({ name: p.name, status: p.status, deadline: p.deadline })),
        companionConnected: status.connected,
        state,
      })
      setText(result.text)
      if (result.changed) await api.saveGreetingState(JSON.stringify(result.state)).catch(() => undefined)
    })()
  }, [projects, ready, name, status.connected])

  return text
}
