import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

interface Props {
  name: string
  src?: string | null
  size?: "default" | "sm" | "lg"
  className?: string
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const first = Array.from(parts[0])[0] ?? ""
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? "") : ""
  return (first + last).toUpperCase()
}

export function UserAvatar({ name, src, size, className }: Props) {
  return (
    <Avatar size={size} className={className}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  )
}
