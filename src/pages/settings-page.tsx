import { Camera } from "lucide-react"
import { useTheme } from "next-themes"
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { toast } from "sonner"
import { PageTop } from "@/components/page-header"
import { Credits } from "@/features/settings/credits"
import { UserAvatar } from "@/components/user-avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { useStartup } from "@/features/startup/use-startup"
import { Skeleton } from "@/components/ui/skeleton"
import { FolderSetupEditor } from "@/features/settings/folder-setup"
import { CompanionInstallCard, useCompanionInstall } from "@/features/companion/companion-install"
import { useProfile, useProfileContext } from "@/features/profile/profile-context"
import { prepareAvatar } from "@/lib/image"
import { ACCENTS, useAccent, useFontPreviews, useTranslucent } from "@/lib/preferences"
import { cn } from "@/lib/utils"
import { open } from "@tauri-apps/plugin-dialog"
import { api, errorMessage, type AerenderStatus, type AppInfo } from "@/lib/tauri"

const MAX_NAME = 60
const THEMES = [
  { value: "system", label: "Match my Mac" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]


/** A group of settings: a small heading, then rows inside one rounded card. */
function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-8 flex-col gap-3">
      <div>
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>
    </section>
  )
}

/** One setting: its name and a line of help on the left, the control on the right. */
function Row({ title, description, htmlFor, children, stack }: { title: string; description?: ReactNode; htmlFor?: string; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={cn("flex gap-x-6 gap-y-2 px-4 py-3.5", stack ? "flex-col" : "items-center justify-between")}>
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {title}
          </label>
        ) : (
          <p className="text-sm font-medium">{title}</p>
        )}
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      {children !== undefined && <div className={cn("shrink-0", stack && "w-full")}>{children}</div>}
    </div>
  )
}

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "appearance", label: "Appearance" },
  { id: "startup", label: "Startup" },
  { id: "after-effects", label: "After Effects" },
  { id: "folders", label: "Folders" },
  { id: "companion", label: "Companion" },
  { id: "about", label: "About" },
]

function ProfileSection() {
  const profile = useProfile()
  const { save } = useProfileContext()
  const [name, setName] = useState(profile.name)
  const [role, setRole] = useState(profile.role ?? "")
  const [avatar, setAvatar] = useState<{ base64: string; previewUrl: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => () => void (avatar && URL.revokeObjectURL(avatar.previewUrl)), [avatar])

  const changed = name.trim() !== profile.name || role.trim() !== (profile.role ?? "") || avatar !== null

  async function onPickFile(file: File | undefined) {
    if (!file) return
    setError(null)
    try {
      setAvatar(await prepareAvatar(file))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return setError("Please enter your name.")
    setSaving(true)
    setError(null)
    try {
      await save(trimmed, role, avatar?.base64 ?? null)
      setAvatar(null)
      toast.success("Profile saved")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section id="profile" title="Profile" description="Shown in the sidebar. It stays on your Mac.">
      <form onSubmit={onSubmit} className="divide-y">
        <Row title="Photo" description="Click the picture to choose a new one.">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="group relative rounded-full outline-none"
            aria-label="Choose a new avatar"
          >
            <UserAvatar name={name || profile.name} src={avatar?.previewUrl ?? profile.avatarDataUrl} size="lg" />
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Camera className="size-4" />
            </span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              void onPickFile(e.target.files?.[0])
              e.target.value = ""
            }}
          />
        </Row>
        <Row title="Name" htmlFor="profile-name" description={error ? <span className="text-destructive" role="alert">{error}</span> : undefined}>
          <Input
            id="profile-name"
            className="w-64"
            autoComplete="off"
            value={name}
            maxLength={MAX_NAME}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </Row>
        <Row title="What you do" htmlFor="profile-role" description="Optional">
          <Input
            id="profile-role"
            className="w-64"
            autoComplete="off"
            value={role}
            maxLength={MAX_NAME}
            placeholder="e.g. Motion Designer"
            onChange={(e) => setRole(e.target.value)}
          />
        </Row>
        <div className="flex justify-end bg-muted/30 px-4 py-2.5">
          <Button type="submit" size="sm" disabled={!changed || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Section>
  )
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const [fontPreviews, setFontPreviews] = useFontPreviews()
  const [accent, setAccent] = useAccent()
  const [translucent, setTranslucent] = useTranslucent()
  return (
    <Section id="appearance" title="Appearance">
      <Row title="Theme" htmlFor="theme" description="Match your Mac, or always light or dark.">
        <Select items={THEMES} value={theme ?? "system"} onValueChange={(v) => v && setTheme(v)}>
          <SelectTrigger id="theme" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEMES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row title="Accent color" description="Colors buttons, checkmarks and focus rings. Project statuses keep their own colors.">
        <div role="radiogroup" aria-label="Accent color" className="flex items-center gap-2">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={accent === a.id}
              aria-label={a.label}
              title={a.label}
              onClick={() => setAccent(a.id)}
              style={a.hue == null ? undefined : { backgroundColor: `oklch(0.6 0.19 ${a.hue})` }}
              className={cn(
                "size-5 rounded-full ring-offset-2 ring-offset-background transition-shadow",
                a.hue == null && "bg-foreground",
                accent === a.id ? "ring-2 ring-foreground/70" : "hover:ring-2 hover:ring-foreground/20",
              )}
            />
          ))}
        </div>
      </Row>
      <Row
        title="Translucent sidebar"
        htmlFor="translucent"
        description="Lets the Mac’s blur show through the sidebar and the window edge. Turn it off for a solid window."
      >
        <Checkbox id="translucent" checked={translucent} onCheckedChange={(v) => setTranslucent(v === true)} />
      </Row>
      <Row
        title="Show font previews"
        htmlFor="font-previews"
        description="Draws a sample of each font in a project’s Fonts tab. Turn it off if a long list feels slow."
      >
        <Checkbox id="font-previews" checked={fontPreviews} onCheckedChange={(v) => setFontPreviews(v === true)} />
      </Row>
    </Section>
  )
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(await api.getDiagnosticReport())
    toast.success("Report copied. Paste it into your message.")
  } catch (e) {
    toast.error(errorMessage(e))
  }
}

function StartupSection() {
  const { info, refresh } = useStartup()
  const change = async (enabled: boolean) => {
    try {
      await api.setLaunchAtLogin(enabled)
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Section id="startup" title="Startup">
      <Row
        title="Open Murre when I log in"
        htmlFor="launch-at-login"
        description={
          info && !info.available
            ? "Only works in the installed app, not in a development build."
            : "It waits quietly in the menu bar, with no window. Click its icon to open it."
        }
      >
        <Checkbox
          id="launch-at-login"
          checked={info?.enabled ?? false}
          disabled={!info || !info.available}
          onCheckedChange={(v) => void change(v === true)}
        />
      </Row>
    </Section>
  )
}

function FoldersSection() {
  return (
    <Section id="folders" title="Folders" description="The sub-folders a new project gets inside 02 Assets, and which files go into each.">
      <FolderSetupEditor />
    </Section>
  )
}

function CompanionSection() {
  const companion = useCompanionInstall()
  const [debugMode, setDebugMode] = useState<boolean | null>(null)
  const [changed, setChanged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.getCompanionDebugMode().then(setDebugMode).catch(() => setDebugMode(false))
  }, [])
  async function toggleDebug(on: boolean) {
    setError(null)
    try {
      setDebugMode(await api.setCompanionDebugMode(on))
      setChanged(true)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <Section id="companion" title="After Effects Companion" description="The panel inside After Effects that scans projects and copies their files.">
      <CompanionInstallCard state={companion} bare />
      <Row
        title="Companion not showing up?"
        htmlFor="cep-debug"
        description={
          <>
            Can’t find Murre under Window &gt; Extensions? Turn this on, then restart After Effects.
            <span className="block">It lets After Effects load panels it can’t verify, every panel, not just Murre.</span>
            {changed && <span className="block text-foreground">Restart After Effects for this to apply.</span>}
            {error && (
              <span role="alert" className="block text-destructive">
                {error}
              </span>
            )}
          </>
        }
      >
        <Checkbox
          id="cep-debug"
          aria-label="Let After Effects load panels it can’t verify"
          checked={debugMode === true}
          disabled={debugMode === null}
          onCheckedChange={(v) => void toggleDebug(v === true)}
        />
      </Row>
    </Section>
  )
}

function AfterEffectsSection() {
  const [status, setStatus] = useState<AerenderStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .getAerenderStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [])

  async function choose(path: string | null) {
    setBusy(true)
    setError(null)
    try {
      setStatus(await api.setAerenderPath(path))
      toast.success(path ? "aerender saved" : "Using automatic detection")
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function pick() {
    try {
      const picked = await open({ multiple: false, directory: false, defaultPath: "/Applications", title: "Choose the aerender file" })
      if (typeof picked === "string") await choose(picked)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const AUTO = "__auto__"
  const choices = status
    ? [{ value: AUTO, label: "Automatic (newest found)" }, ...status.detected.map((d) => ({ value: d.path, label: d.version ? `${d.label} (${d.version})` : d.label }))]
    : []
  return (
    <Section id="after-effects" title="After Effects" description="Used for new projects, “Open in After Effects” and rendering.">
      {!status && !error && <Skeleton className="m-4 h-10" />}
      {status && status.detected.length > 1 && (
        <Row title="Main version" htmlFor="ae-main" description="The After Effects you use most.">
          <Select items={choices} value={status.saved ?? AUTO} disabled={busy} onValueChange={(v) => v && void choose(v === AUTO ? null : v)}>
            <SelectTrigger id="ae-main" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
      {status && (
        <Row
          title="aerender"
          description={
            status.active ? (
              <span data-testid="aerender-active">
                <span className="break-all font-mono">{status.active.path}</span>
                <br />
                {status.active.version} · {status.active.chosen ? "chosen by you" : "found automatically"}
              </span>
            ) : (
              <span role="alert" className="text-destructive">
                {status.problem ?? "aerender was not found."}
              </span>
            )
          }
        >
          <div className="flex gap-2">
            {status.saved && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void choose(null)}>
                Use automatic
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void pick()}>
              Choose…
            </Button>
          </div>
        </Row>
      )}
      {error && (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        Rendering uses Adobe’s aerender, which comes with After Effects. Murre looks for it in /Applications.
        {status && status.detected.length > 0 ? ` Found: ${status.detected.map((d) => d.label).join(", ")}.` : ""}
      </p>
    </Section>
  )
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; info: AppInfo }

export function SettingsPage() {
  const [state, setState] = useState<State>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    api
      .getAppInfo()
      .then((info) => !cancelled && setState({ status: "ready", info }))
      .catch((e) => !cancelled && setState({ status: "error", message: errorMessage(e) }))
    return () => {
      cancelled = true
    }
  }, [])

  // The page card scrolls, like every other page, so the soft blur under the tab strip works here too.
  // The section list highlights the one being read.
  const [active, setActive] = useState(SECTIONS[0].id)
  const spy = useCallback(() => {
    const box = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')
    if (!box) return
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) return setActive(SECTIONS[SECTIONS.length - 1].id) // the last sections are short
    const line = box.getBoundingClientRect().top + 160
    let current = SECTIONS[0].id
    for (const x of SECTIONS) {
      const el = document.getElementById(x.id)
      if (el && el.getBoundingClientRect().top <= line) current = x.id
    }
    setActive(current)
  }, [])
  useEffect(spy, [spy, state.status])
  useEffect(() => {
    const box = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')
    box?.addEventListener("scroll", spy, { passive: true })
    return () => box?.removeEventListener("scroll", spy)
  }, [spy])

  return (
    <div className="flex min-h-full flex-col">
      <PageTop />
      <div className="mx-auto flex w-full max-w-[1160px] gap-12 px-6 py-8">
        <nav aria-label="Settings sections" className="sticky top-[calc(var(--tabstrip-h)+2rem)] hidden h-fit w-40 shrink-0 flex-col gap-0.5 lg:flex">
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-current={active === x.id ? "true" : undefined}
              onClick={() => {
                setActive(x.id)
                const box = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')
                const el = document.getElementById(x.id)
                if (box && el) {
                  const tabs = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.5
                  box.scrollTo({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - tabs - 24, behavior: "smooth" })
                }
              }}
              className={cn(
                "rounded-lg px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted hover:text-foreground",
                active === x.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {x.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 max-w-[920px] flex-1 flex-col gap-9">
          <ProfileSection />
          <AppearanceSection />
          <StartupSection />
          <AfterEffectsSection />
          <FoldersSection />
          <CompanionSection />
          <Section id="about" title="About">
            {state.status === "loading" && <Skeleton className="m-4 h-16" />}
            {state.status === "error" && (
              <p role="alert" className="px-4 py-3 text-sm text-destructive">
                Could not load app information: {state.message}
              </p>
            )}
            {state.status === "ready" && (
              <>
                <Row title="Version">
                  <span className="text-sm">{state.info.version}</span>
                </Row>
                <Row title="Updates" description="Murre also checks once a day while it’s open.">
                  <Button variant="outline" size="sm" onClick={() => void api.checkForUpdates()}>
                    Check for updates
                  </Button>
                </Row>
                <Row title="Data folder" description="Your profile, project list and global notes live here." stack>
                  <span className="block break-all font-mono text-xs text-muted-foreground">{state.info.dataDir}</span>
                </Row>
                <Row title="Database schema">
                  <span className="text-sm">v{state.info.schemaVersion}</span>
                </Row>
                <Row
                  title="Report a problem"
                  description="Copies the recent activity log, without file paths or names, to paste into a message. Nothing is sent anywhere."
                >
                  <Button variant="outline" size="sm" onClick={() => void copyReport()}>
                    Copy report
                  </Button>
                </Row>
              </>
            )}
          </Section>
          <Credits />
        </div>
      </div>
    </div>
  )
}
