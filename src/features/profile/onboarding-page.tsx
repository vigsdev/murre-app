import { Camera } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { UserAvatar } from "@/components/user-avatar"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { CompanionInstallCard, useCompanionInstall } from "@/features/companion/companion-install"
import { defaultInstall, installName, useAeInstalls } from "@/features/projects/use-ae-installs"
import { prepareAvatar } from "@/lib/image"
import { api } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useProfileContext } from "./profile-context"
import avatar1 from "@/assets/avatar-01.jpg"
import avatar2 from "@/assets/avatar-02.jpg"
import avatar3 from "@/assets/avatar-03.jpg"
import avatar4 from "@/assets/avatar-04.jpg"
import avatar5 from "@/assets/avatar-05.jpg"

const MAX_NAME = 60
const PRESETS = [avatar1, avatar2, avatar3, avatar4, avatar5]

type Avatar = { base64: string; previewUrl: string; preset: number | null }

export function OnboardingPage() {
  const { save } = useProfileContext()
  const [step, setStep] = useState<"profile" | "ae" | "companion">("profile")
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [avatar, setAvatar] = useState<Avatar | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const ae = useAeInstalls()
  const companion = useCompanionInstall()
  const [skipOffered, setSkipOffered] = useState(false)
  const [aePath, setAePath] = useState<string | null>(null)
  const chosenAe = aePath ?? defaultInstall(ae)?.path ?? ""
  const hasChoice = !!ae && ae.installs.length > 1

  useEffect(
    () => () => {
      if (avatar && avatar.preset === null) URL.revokeObjectURL(avatar.previewUrl)
    },
    [avatar],
  )

  async function choose(file: File, preset: number | null) {
    setError(null)
    try {
      const prepared = await prepareAvatar(file)
      if (preset !== null) URL.revokeObjectURL(prepared.previewUrl)
      setAvatar({ base64: prepared.base64, previewUrl: preset !== null ? PRESETS[preset] : prepared.previewUrl, preset })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function pickPreset(i: number) {
    try {
      const blob = await (await fetch(PRESETS[i])).blob()
      await choose(new File([blob], `avatar-${i + 1}.jpg`, { type: blob.type || "image/jpeg" }), i)
    } catch {
      setError("That avatar didn’t make it. Try another image.")
    }
  }

  async function finish() {
    setSaving(true)
    setError(null)
    try {
      // This is also the After Effects used to render and to open projects. If it cannot be saved
      // (for example a beta that will not report its version), setup still finishes; Settings can fix it.
      if (hasChoice && chosenAe) await api.setAerenderPath(chosenAe).catch(() => undefined)
      await save(name.trim(), role, avatar?.base64 ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  async function onSubmitProfile(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError("Please enter your name.")
    setError(null)
    setStep(hasChoice ? "ae" : "companion")
  }

  if (step === "ae") {
    return (
      <main className="solid-screen flex min-h-svh items-center justify-center p-6" data-tauri-drag-region>
        <div className="flex w-full max-w-sm flex-col gap-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Choose your After Effects version</h1>
            <p className="text-sm text-muted-foreground">
              We found multiple versions of Adobe After Effects installed on your Mac. Select the one you use most often.
            </p>
          </div>
          <div role="radiogroup" aria-label="After Effects version" className="flex flex-col gap-2">
            {ae?.installs.map((i) => (
              <button
                key={i.path}
                type="button"
                role="radio"
                aria-checked={chosenAe === i.path}
                onClick={() => setAePath(i.path)}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-4 py-3 text-left text-sm transition-colors hover:bg-accent",
                  chosenAe === i.path && "border-primary bg-accent",
                )}
              >
                {installName(i)}
                <span
                  className={cn("size-4 rounded-full border", chosenAe === i.path && "border-4 border-primary")}
                  aria-hidden
                />
              </button>
            ))}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="lg" className="flex-1" disabled={saving} onClick={() => setStep("profile")}>
              Back
            </Button>
            <Button type="button" size="lg" className="flex-1" disabled={saving || !chosenAe} onClick={() => setStep("companion")}>
              Continue
            </Button>
          </div>
        </div>
      </main>
    )
  }

  if (step === "companion") {
    return (
      <main className="solid-screen flex min-h-svh items-center justify-center p-6" data-tauri-drag-region>
        <div className="flex w-full max-w-sm flex-col gap-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Install the After Effects Companion</h1>
            <p className="text-sm text-muted-foreground">
              Murre uses a small After Effects extension to create and scan projects. A tiny sidekick for a very big app.
            </p>
          </div>
          <CompanionInstallCard state={companion} />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="lg" className="flex-1" disabled={saving} onClick={() => setStep(hasChoice ? "ae" : "profile")}>
                Back
              </Button>
              <Button type="button" size="lg" className="flex-1" disabled={saving || !companion.ready} onClick={() => void finish()}>
                {saving ? "Saving…" : "Finish"}
              </Button>
            </div>
            {companion.error && !companion.ready && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-4"
                onClick={() => {
                  setSkipOffered(true)
                  void finish()
                }}
              >
                {skipOffered ? "Skipping…" : "Install it later from Settings"}
              </button>
            )}
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="solid-screen flex min-h-svh items-center justify-center p-6" data-tauri-drag-region>
      <form onSubmit={onSubmitProfile} className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Hey, welcome to Murre.</h1>
          <p className="text-sm text-muted-foreground">Let’s get acquainted before we tackle your folder situation. Your details stay on your Mac.</p>
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel>Choose your avatar</FieldLabel>
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Avatar">
              {PRESETS.map((src, i) => (
                <button
                  key={src}
                  type="button"
                  role="radio"
                  aria-checked={avatar?.preset === i}
                  aria-label={`Avatar ${i + 1}`}
                  onClick={() => void pickPreset(i)}
                  className={cn(
                    "size-11 shrink-0 overflow-hidden rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-background transition",
                    avatar?.preset === i ? "ring-primary" : "opacity-80 hover:opacity-100",
                  )}
                >
                  <img src={src} alt="" className="size-full object-cover" />
                </button>
              ))}
              <button
                type="button"
                aria-label="Upload your own avatar"
                onClick={() => fileInput.current?.click()}
                className={cn(
                  "relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground ring-2 ring-transparent ring-offset-2 ring-offset-background transition hover:text-foreground",
                  avatar?.preset === null && "ring-primary",
                )}
              >
                {avatar?.preset === null ? (
                  <UserAvatar name={name} src={avatar.previewUrl} className="size-full" />
                ) : (
                  <Camera className="size-4" />
                )}
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void choose(f, null)
                e.target.value = ""
              }}
            />
            <FieldDescription>Pick one of our five little faces. Or bring your own.</FieldDescription>
          </Field>

          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="name">What do your friends call you?</FieldLabel>
            <Input
              id="name"
              autoFocus
              autoComplete="off"
              value={name}
              maxLength={MAX_NAME}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="role">What do you make?</FieldLabel>
            <Input
              id="role"
              autoComplete="off"
              value={role}
              maxLength={MAX_NAME}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Enter your role (e.g., Motion Designer, Video Editor)"
            />
          </Field>
        </FieldGroup>

        <Button type="submit" size="lg" disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Continue"}
        </Button>
      </form>
    </main>
  )
}
