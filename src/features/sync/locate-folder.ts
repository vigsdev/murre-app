import { open } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import { api, errorMessage, type ProjectRecord } from "@/lib/tauri"

/**
 * Ask for the folder a project moved to and link it. Nothing in the folder is changed; the
 * folder must hold the same project (matched by its stored ID). Returns the updated record.
 */
export async function locateProjectFolder(project: ProjectRecord): Promise<ProjectRecord | null> {
  try {
    const picked = await open({
      directory: true,
      multiple: false,
      title: `Choose the folder for “${project.name}”`,
    })
    if (typeof picked !== "string") return null
    const updated = await api.relinkProject(project.id, picked)
    toast.success(`Linked “${updated.name}”`, { description: updated.path })
    return updated
  } catch (e) {
    toast.error(errorMessage(e))
    return null
  }
}
