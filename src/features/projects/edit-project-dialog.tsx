import { recordGreetingEvent } from "@/features/home/greetings/events"
import { useState, type FormEvent } from "react"
import { DatePicker } from "@/components/date-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { SpaceSelect } from "@/features/spaces/space-select"
import { api, errorMessage, type ProjectPriority, type ProjectRecord, type ProjectStatus } from "@/lib/tauri"
import { PrioritySelect, StatusSelect } from "./selects"

interface Props {
  project: ProjectRecord | null
  onClose: () => void
  onSaved: (p: ProjectRecord) => void
}

export function EditProjectDialog({ project, onClose, onSaved }: Props) {
  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {/* Keyed so the form state resets for each project. */}
        {project && <EditForm key={project.id} project={project} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

function EditForm({ project, onClose, onSaved }: { project: ProjectRecord; onClose: () => void; onSaved: (p: ProjectRecord) => void }) {
  const [name, setName] = useState(project.name)
  const [client, setClient] = useState(project.client ?? "")
  const [deadline, setDeadline] = useState<string | null>(project.deadline)
  const [priority, setPriority] = useState<ProjectPriority>(project.priority)
  const [status, setStatus] = useState<ProjectStatus>(project.status)
  const [description, setDescription] = useState(project.description ?? "")
  const [spaceId, setSpaceId] = useState<string | null>(project.spaceId)
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setNameError("Please enter a project name.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await api.updateProject({
        id: project.id,
        name,
        client: client.trim() || null,
        deadline,
        priority,
        description: description.trim() || null,
        status,
      })
      if (status === "completed" && project.status !== "completed") recordGreetingEvent("completed", saved.name ?? name)
      if (spaceId !== project.spaceId) {
        try {
          onSaved(await api.setProjectSpace(project.id, spaceId))
        } catch (err) {
          // The other changes were saved; only the Space could not be changed.
          setError(`Your other changes were saved, but the Space could not be changed: ${errorMessage(err)}`)
          setSaving(false)
        }
        return
      }
      onSaved(saved)
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>Edit project</DialogTitle>
        <DialogDescription>Changes are saved to the project's own metadata.</DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor="edit-name">Project name</FieldLabel>
          <Input
            id="edit-name"
            autoComplete="off"
            value={name}
            maxLength={100}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => {
              setName(e.target.value)
              setNameError(null)
            }}
          />
          <FieldDescription>Only the display name changes. The project's folder is not renamed.</FieldDescription>
          {nameError && <FieldError>{nameError}</FieldError>}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="edit-client">Client</FieldLabel>
            <Input id="edit-client" autoComplete="off" value={client} maxLength={100} onChange={(e) => setClient(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-deadline">Deadline</FieldLabel>
            <DatePicker id="edit-deadline" disablePast value={deadline} onChange={setDeadline} placeholder="No deadline. Lucky you." />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-priority">Priority</FieldLabel>
            <PrioritySelect id="edit-priority" value={priority} onChange={setPriority} />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-status">Status</FieldLabel>
            <StatusSelect id="edit-status" value={status} onChange={setStatus} />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="edit-space">Space</FieldLabel>
          <SpaceSelect id="edit-space" value={spaceId} onChange={setSpaceId} />
        </Field>
        <Field>
          <FieldLabel htmlFor="edit-description">Description</FieldLabel>
          <Textarea id="edit-description" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </FieldGroup>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  )
}
