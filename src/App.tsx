import { Home } from "lucide-react"
import { Route, Routes, useParams } from "react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { ComingSoonPage } from "@/components/coming-soon-page"
import { TitleBar } from "@/components/title-bar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TopBlur } from "@/features/tabs/edge-blur"
import { Switcher } from "@/features/switcher/switcher"
import { TabStrip } from "@/features/tabs/tab-strip"
import { TabsProvider } from "@/features/tabs/tabs-context"
import { ProjectDetailPage } from "@/features/projects/detail/project-detail-page"
import { ProjectsPage } from "@/features/projects/projects-page"
import { NewProjectPage } from "@/features/projects/new-project-page"
import { AddProjectProgress } from "@/features/projects/add-from-ae"
import { HomePage } from "@/features/home/home-page"
import { useNativeTheme } from "@/hooks/use-native-theme"
import { useAppearance } from "@/lib/preferences"
import { useAppMenuEvents } from "@/hooks/use-app-menu-events"
import { useFlushOnClose } from "@/hooks/use-flush-on-close"
import { MissingProjectPrompt } from "@/features/sync/missing-project-prompt"
import { SyncProvider } from "@/features/sync/sync-context"
import { SpacesProvider } from "@/features/spaces/spaces-context"
import { ProjectDndProvider } from "@/features/spaces/project-dnd"
import { CalendarPage } from "@/features/calendar/calendar-page"
import { NotesPage } from "@/pages/notes-page"
import { ReferenxePage } from "@/pages/referenxe-page"
import { SettingsPage } from "@/pages/settings-page"

/** A Space's page: the Projects list filtered to that Space (keyed so filters reset per Space). */
function SpacePage() {
  const { id } = useParams()
  return <ProjectsPage key={id} spaceId={id} />
}

function App() {
  useFlushOnClose()
  useAppMenuEvents()
  useNativeTheme()
  useAppearance()
  return (
    <SyncProvider>
    <SpacesProvider>
    <SidebarProvider>
      <TitleBar />
      <AddProjectProgress />
      <MissingProjectPrompt />
      <ProjectDndProvider>
      <TabsProvider>
      <AppSidebar />
      <Switcher />
      {/* The page card is the scroll box: it is exactly the window's height and clips its content to the rounded corners. */}
      <SidebarInset className="h-[calc(100svh-1rem)] min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
        <TopBlur />
        <TabStrip />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/spaces/:id" element={<SpacePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/referenxe" element={<ReferenxePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={<ComingSoonPage title="Well, this is awkward." icon={Home} description="That page wandered off. Try heading back home." />}
          />
        </Routes>
      </SidebarInset>
      </TabsProvider>
      </ProjectDndProvider>
    </SidebarProvider>
    </SpacesProvider>
    </SyncProvider>
  )
}

export default App
