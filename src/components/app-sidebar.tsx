import { CircleHelp, Plus, Settings } from "lucide-react"
import { NavLink, useLocation } from "react-router"
import { motion } from "motion/react"
import { MOVE } from "@/lib/motion"
import { openUrl } from "@tauri-apps/plugin-opener"
import { UserAvatar } from "@/components/user-avatar"
import { SpacesNav } from "@/features/spaces/spaces-nav"
import { useProfile } from "@/features/profile/profile-context"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { HELP_URL } from "@/config"
import { mainNav } from "@/nav"

function isActive(pathname: string, to: string) {
  // "New Project" has its own entry, so it must not also light up "Projects".
  if (to === "/projects" && pathname === "/projects/new") return false
  return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`)
}

/** "Vignesh’s Space"; a name that already ends in s only gets the apostrophe. */
function spaceName(name: string) {
  const n = name.trim() || "Your"
  return /s$/i.test(n) ? `${n}’ Space` : `${n}’s Space`
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const profile = useProfile()

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="gap-2">
        <div data-tauri-drag-region className="mac-titlebar-spacer" aria-hidden />
        <NavLink
          to="/settings"
          title="The little corner where you make Murre yours."
          className="flex items-center gap-3 rounded-xl px-2 py-1.5 outline-hidden"
        >
          <UserAvatar name={profile.name} src={profile.avatarDataUrl} size="lg" />
          <span className="min-w-0 truncate text-base font-semibold tracking-tight">{spaceName(profile.name)}</span>
        </NavLink>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="New Project"
              render={<NavLink to="/projects/new" />}
              className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/80 active:text-primary-foreground [&_svg]:text-primary-foreground"
            >
              <Plus />
              <span>New Project</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNav.map((item) => {
                const active = isActive(pathname, item.to)
                return (
                  <SidebarMenuItem key={item.to}>
                    {/* One highlight that slides between items. It lives on the item, not the button, which clips what is inside it. */}
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        aria-hidden
                        transition={MOVE}
                        className="absolute inset-0 rounded-xl bg-foreground/[0.08] dark:bg-foreground/[0.12]"
                      />
                    )}
                    <SidebarMenuButton
                      tooltip={item.title}
                      isActive={active}
                      render={<NavLink to={item.to} />}
                      className="relative data-active:bg-transparent dark:data-active:bg-transparent"
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SpacesNav />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={HELP_URL ? "Help" : "Help (website not configured yet)"}
              disabled={!HELP_URL}
              onClick={() => HELP_URL && void openUrl(HELP_URL)}
            >
              <CircleHelp />
              <span>Help</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
              isActive={isActive(pathname, "/settings")}
              render={<NavLink to="/settings" />}
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
