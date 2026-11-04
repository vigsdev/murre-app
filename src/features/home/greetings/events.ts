import { api } from "@/lib/tauri"
import { parseState, type GreetingEventKind } from "./greetings"

// One write at a time, so two events close together cannot overwrite each other.
let chain: Promise<unknown> = Promise.resolve()

/**
 * Tells Home that something worth a greeting just happened (a project finished, a package built, a scan done).
 * Fire and forget: a greeting is never worth an error message.
 */
export function recordGreetingEvent(kind: GreetingEventKind, project: string | null) {
  chain = chain
    .then(async () => {
      const state = parseState(await api.getGreetingState().catch(() => null))
      state.events = [...state.events, { kind, project, at: Date.now() }].slice(-10)
      await api.saveGreetingState(JSON.stringify(state))
    })
    .catch(() => undefined)
}
