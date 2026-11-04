import { NotesTab } from "@/features/projects/detail/notes-tab"

/** App-wide notes, stored in the application data folder (not in any project). The page is just the editor, edge to edge. */
export function NotesPage() {
  return (
    <div className="fit-page flex flex-col pt-(--tabstrip-h)">
      <NotesTab projectId={null} fill placeholder="A thought that doesn’t belong to any one project? Park it here…" />
    </div>
  )
}
