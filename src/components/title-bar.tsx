import { SidebarTrigger } from "@/components/ui/sidebar"

/**
 * macOS only (hidden by CSS elsewhere). The row along the top drags the window, and the sidebar button sits in a
 * fixed spot: at the sidebar's right edge when it is open, next to the traffic lights when it is closed.
 */
export function TitleBar() {
  return (
    <>
      <div data-tauri-drag-region className="mac-titlebar" aria-hidden />
      <div className="mac-trigger">
        <SidebarTrigger />
      </div>
    </>
  )
}
