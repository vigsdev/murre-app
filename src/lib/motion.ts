// How things move in Murre. One place, so every page feels the same.
//
// The rules: motion explains a change (something moved, appeared or left) and never makes anyone wait for it.
// Nothing is slower than about a third of a second, nothing bounces, and nothing moves for people who have
// Reduce Motion turned on (MotionConfig in main.tsx handles that for everything made with Motion).

import type { Transition } from "motion/react"

/** Starts quickly and settles gently. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const

export const DURATION = { fast: 0.12, base: 0.2, slow: 0.3 } as const

/** Something sliding to a new place: a card making room, the sidebar highlight moving. Firm, with no wobble. */
export const MOVE: Transition = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 }

/** Something appearing. */
export const ENTER: Transition = { duration: DURATION.base, ease: EASE_OUT }

/** Something leaving. Quicker than entering, so a removal never feels like a wait. */
export const LEAVE: Transition = { duration: DURATION.fast, ease: EASE_OUT }

/** Props for a list item that fades in, glides when its neighbours change, and fades out. */
export const listItem = {
  layout: "position" as const,
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97, transition: LEAVE },
  transition: { layout: MOVE, opacity: ENTER, scale: ENTER },
}
