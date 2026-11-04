import { Calendar, FileText, FolderKanban, Home, PenTool, type LucideIcon } from "lucide-react"

export interface NavItem {
  title: string
  to: string
  icon: LucideIcon
}

export const mainNav: NavItem[] = [
  { title: "Home", to: "/", icon: Home },
  { title: "Projects", to: "/projects", icon: FolderKanban },
  { title: "Notes", to: "/notes", icon: FileText },
  { title: "Calendar", to: "/calendar", icon: Calendar },
  { title: "Referenxe", to: "/referenxe", icon: PenTool },
]
