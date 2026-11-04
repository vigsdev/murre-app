import {
  Bookmark,
  Briefcase,
  Camera,
  Clapperboard,
  Film,
  Flag,
  Folder,
  Globe,
  Heart,
  Layers,
  Music,
  Palette,
  Rocket,
  Star,
  Tv,
  Zap,
  type LucideIcon,
} from "lucide-react"

/** Keys must match `spaces::ICONS` in the Rust backend. */
export const SPACE_ICONS: Record<string, LucideIcon> = {
  layers: Layers,
  folder: Folder,
  briefcase: Briefcase,
  star: Star,
  heart: Heart,
  film: Film,
  clapperboard: Clapperboard,
  music: Music,
  camera: Camera,
  palette: Palette,
  rocket: Rocket,
  flag: Flag,
  zap: Zap,
  bookmark: Bookmark,
  globe: Globe,
  tv: Tv,
}

export const SPACE_ICON_KEYS = Object.keys(SPACE_ICONS)

export function SpaceIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = SPACE_ICONS[icon] ?? Layers
  return <Icon className={className} />
}
