import { cn } from "@/lib/utils"

/**
 * A keyframe diamond, Murre's one signature mark. It means "this is the moment": a deadline in Coming up, and the
 * project that is open in After Effects right now on the time timeline. Use it only for those.
 */
export function Keyframe({ color, className, title }: { color?: string; className?: string; title?: string }) {
  return (
    <span
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      title={title}
      className={cn("inline-block size-2 shrink-0 rotate-45 rounded-[2px] bg-current", className)}
      style={color ? { background: color } : undefined}
    />
  )
}
