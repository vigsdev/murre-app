/**
 * Editors that save a moment after you stop typing (notes, references) register a function here, so closing the
 * window can write anything still pending before the app exits.
 */
type Flusher = () => Promise<unknown> | void

const flushers = new Set<Flusher>()

export function registerFlush(fn: Flusher): () => void {
  flushers.add(fn)
  return () => {
    flushers.delete(fn)
  }
}

/** Runs every registered flush; one failing does not stop the others. */
export async function flushAll(): Promise<void> {
  await Promise.allSettled([...flushers].map((f) => Promise.resolve().then(f)))
}
