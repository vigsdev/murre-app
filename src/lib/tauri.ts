import { invoke } from "@tauri-apps/api/core"

/** Shape of errors returned by backend commands (see src-tauri/src/error.rs). */
export interface BackendError {
  kind: "io" | "json" | "database" | "corrupt" | "already_exists" | "conflict" | "invalid"
  message: string
}

export interface AppInfo {
  version: string
  dataDir: string
  schemaVersion: number
}

export interface Profile {
  name: string
  /** What the user does, e.g. "Motion Designer". */
  role: string | null
  /** `data:` URL of the avatar image, if one is set. */
  avatarDataUrl: string | null
}

export type ProjectStatus =
  | "not_started"
  | "in_progress"
  | "in_review"
  | "quality_check"
  | "completed"
  | "archived"

export type ProjectPriority = "low" | "medium" | "high"

export interface NewProjectInput {
  name: string
  parentDir: string
  client: string | null
  /** `YYYY-MM-DD` */
  deadline: string | null
  priority: ProjectPriority
  description: string | null
  status: ProjectStatus
  spaceId: string | null
}

export interface ProjectRecord {
  id: string
  name: string
  client: string | null
  deadline: string | null
  priority: ProjectPriority
  description: string | null
  status: ProjectStatus
  spaceId: string | null
  createdAt: number
  updatedAt: number
  /** Absolute path of the project folder. */
  path: string
  /** False when the folder cannot be found (e.g. a drive is disconnected). */
  available: boolean
}

export interface UpdateProjectInput {
  id: string
  name: string
  client: string | null
  deadline: string | null
  priority: ProjectPriority
  description: string | null
  status: ProjectStatus
}

export interface ImportInspection {
  name: string
  hasMetadata: boolean
  alreadyImported: boolean
}

export type ImportOutcome = "imported" | "relinked" | "metadata_created"

export interface ImportResult {
  record: ProjectRecord
  outcome: ImportOutcome
}

export interface Workfile {
  /** Relative to the project folder, `/`-separated. */
  path: string
  absolutePath: string
  name: string
  sizeBytes: number
  /** Unix seconds. */
  modifiedAt: number
  version: number | null
  isLatestVersion: boolean
  isCurrent: boolean
  /** One line the designer wrote about this version, e.g. "client wanted the logo bigger". */
  note: string | null
}

export interface CurrentAep {
  path: string
  markedAt: number
  /** False when the marked file is no longer on disk. */
  exists: boolean
}

export interface WorkfileScan {
  workfiles: Workfile[]
  currentAep: CurrentAep | null
  truncated: boolean
}

export interface Task {
  id: string
  title: string
  done: boolean
  createdAt: number
  completedAt: number | null
}

export type AssetKind = "directory" | "file" | "symlink"

export interface AssetEntry {
  name: string
  /** Relative to the project folder, `/`-separated. */
  path: string
  absolutePath: string
  kind: AssetKind
  sizeBytes: number | null
  /** Unix seconds. */
  modifiedAt: number
  /** Lowercase, without the dot. */
  extension: string | null
  /** True for regular files of a type the app is willing to open. */
  openable: boolean
}

export interface AssetListing {
  /** Folder that was listed, relative to the project folder; empty for the root. */
  path: string
  entries: AssetEntry[]
  truncated: boolean
}

export interface NotesView {
  /** Increases on every save; saves must name the revision they were based on. */
  revision: number
  updatedAt: number | null
  /** First page: a Tiptap JSON document, or null when nothing has been written yet. */
  content: Record<string, unknown> | null
  /** The pages after the first, in order. */
  pages: { id: string; content: Record<string, unknown> | null }[]
}

export function isConflictError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "conflict"
}

function isBackendError(e: unknown): e is BackendError {
  return typeof e === "object" && e !== null && "message" in e && "kind" in e
}

export function errorMessage(e: unknown): string {
  if (isBackendError(e)) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

export type MediaKind = "video" | "image" | "audio"
export type RenderFolder = "05 Pre-Renders" | "06 Renders" | "07 Deliverables"

export interface RenderEntry {
  /** Relative to the project folder, `/`-separated. */
  path: string
  absolutePath: string
  name: string
  folder: RenderFolder
  kind: MediaKind
  extension: string
  sizeBytes: number
  /** Unix MILLISECONDS (used as part of the approval fingerprint). */
  modifiedAt: number
  /** `changed`: approved earlier, but the file's size or date differs now. */
  approval: { approvedAt: number; state: "current" | "changed" } | null
}

export interface RendersListing {
  entries: RenderEntry[]
  truncated: boolean
  /** Approved files no longer on disk (their records are kept). */
  missingApproved: string[]
}

export interface MediaTools {
  ffmpeg: string | null
  ffprobe: string | null
}

export interface MediaInfo {
  formatName: string | null
  durationSecs: number | null
  bitRate: number | null
  video: {
    codec: string | null
    width: number | null
    height: number | null
    frameRate: number | null
    pixelFormat: string | null
  } | null
  audio: { codec: string | null; sampleRate: number | null; channels: number | null } | null
}

export interface ReferencesView {
  revision: number
  updatedAt: number | null
  /** The saved board (`{ format: "sequenxe-board", items, view }`), an older tldraw snapshot, or `null` for an empty board. */
  canvas: Record<string, unknown> | null
}

export interface ImportedMedia {
  /** File name inside the project's reference media folder. */
  file: string
  mediaType: "image" | "video" | "pdf"
  sizeBytes: number
}

export interface CalendarEvent {
  id: string
  title: string
  /** `YYYY-MM-DD` */
  date: string
  notes: string | null
  createdAt: number
  updatedAt: number
}

export interface EventInput {
  title: string
  date: string
  notes: string | null
}

export interface Space {
  id: string
  name: string
  /** One of the icon keys in `features/spaces/space-icons.tsx`. */
  icon: string
  position: number
}

export type SyncProblemKind = "replaced" | "unreadable"

export interface SyncProblem {
  id: string
  name: string
  kind: SyncProblemKind
  message: string
}

/** Result of comparing the app's index with the project folders on disk. */
export interface ReconcileReport {
  checked: number
  /** Projects whose index row was refreshed from their project.json. */
  synced: string[]
  /** Projects whose folder is not there right now. */
  unavailable: string[]
  problems: SyncProblem[]
}

/** Sent while a project is open and something in its folder changed. */
export interface ProjectChange {
  projectId: string
  /** Metadata files directly inside .murre/ that changed, e.g. "colors.json". */
  metadata: string[]
  /** Something outside .murre/ changed (assets, renders, AEP files). */
  files: boolean
  /** The project folder itself was removed or renamed. */
  rootChanged: boolean
}

export interface ColorEntry {
  /** Uppercase `#RRGGBB`. */
  hex: string
  alpha: number
  comp: string | null
  /** After Effects' id for the composition; `null` for scans made before jumping was added. */
  compId: number | null
  layer: string | null
  /** Position of the layer in its composition (1 = top); `null` for older scans. */
  layerIndex: number | null
  property: string | null
}

/** Read-only: the Companion writes `.murre/colors.json`. */
export interface ColorsView {
  lastScanAt: string | number | null
  colors: ColorEntry[]
  /** Entries in the file that could not be read. */
  skipped: number
  /** Entries beyond the display limit. */
  truncated: number
}

export interface ExpressionEntry {
  expression: string
  comp: string | null
  compId: number | null
  layer: string | null
  layerIndex: number | null
  property: string | null
  /** `false` when the expression is switched off in After Effects. */
  enabled: boolean
}

/** Read-only: the Companion writes `.murre/expressions.json`. */
export interface ExpressionsView {
  lastScanAt: string | number | null
  expressions: ExpressionEntry[]
  /** Entries in the file that could not be read. */
  skipped: number
  /** Entries beyond the display limit. */
  truncated: number
}

export interface FontEntry {
  postScriptName: string
  family: string | null
  style: string | null
  location: string | null
  adobeFonts: boolean
  /** After Effects had to substitute this font when the project was scanned. */
  missing: boolean
  layerCount: number
  uses: { comp: string | null; compId: number | null; layer: string | null; layerIndex: number | null }[]
  /** Whether the font file is on this Mac now; `null` when that can't be known. */
  installed: boolean | null
}

/** Read-only: the Companion writes `.murre/fonts.json`. */
export interface FontsView {
  lastScanAt: string | number | null
  /** `project`: every font in the project (After Effects 24.5+). `layers`: the first font of each text layer. */
  method: "project" | "layers"
  fonts: FontEntry[]
  skipped: number
  truncated: number
}

export interface NeedFont {
  label: string
  postScriptName: string
  /** `ok`, `adobe` (can't be checked), `notOnMac`, or `missing` (After Effects used a stand-in when scanned). */
  state: "ok" | "adobe" | "notOnMac" | "missing"
}

export interface NeedPlugin {
  name: string
  matchName: string
  layerCount: number
  /** A file or folder with a matching name was found in this Mac's plugin folders. */
  seenInstalled: boolean
}

/** What a project needs to open properly. Read-only: built from the Companion's scan. */
export interface NeedsView {
  scanned: boolean
  lastScanAt: string | number | null
  aeVersion: string | null
  /** Years of the After Effects versions installed on this Mac, e.g. ["2025"]. */
  aeInstalled: string[]
  /** `false` only when every After Effects found here is older than the scanned version. */
  aeOk: boolean | null
  fontsMethod: "project" | "layers"
  fonts: NeedFont[]
  plugins: NeedPlugin[]
}

export interface PackageWorkfile {
  path: string
  name: string
  sizeBytes: number
  modifiedAt: number
}

/** What would go in a delivery package, and what would greet the other person with color bars. */
export interface PackageProjectNotes {
  /** Notes pages that have some text. */
  notePages: number
  todos: number
  referenceFiles: number
  referenceBytes: number
}

export interface PackageCheck {
  projectNotes: PackageProjectNotes
  workfile: PackageWorkfile | null
  otherVersions: PackageWorkfile[]
  scanned: boolean
  /** The workfile was saved after the last scan. */
  stale: boolean
  footageInside: number
  footageInsideBytes: number
  footageMissing: string[]
  footageMissingTotal: number
  footageOutside: string[]
  footageOutsideTotal: number
  premiereFiles: string[]
  premiereBytes: number
  fonts: { label: string; bundle: boolean; reason: string | null }[]
  fontsBytes: number
  plugins: string[]
  aeVersion: string | null
  defaultDestination: string
  totalBytes: number
}

export interface PackageOptions {
  destination: string
  includeFonts: boolean
  includeOtherVersions: boolean
  /** The notes, to-do list and reference images, in a `Project notes` folder. */
  includeProjectNotes: boolean
  format: "folder" | "zip" | "both"
  allowProblems: boolean
}

export interface PackageProgress {
  doneBytes: number
  totalBytes: number
  step: string
}

export interface PackageReport {
  folder: string | null
  zip: string | null
  files: number
  bytes: number
  fontsIncluded: number
}

/** What the After Effects Companion last reported over the live link. */
/** Per-project Companion settings, saved in the project's `.murre/settings.json`. */
export interface ProjectSettings {
  copyRelinkOnScan: boolean
  trashOriginals: boolean
  /** Minutes between automatic scans: 0 (off), 5, 10 or 20. */
  autoScanMinutes: number
}

export interface CompanionConnection {
  id: number
  /** For example "After Effects 2026" or "After Effects 2026 Beta". */
  label: string
  projectId: string | null
  aepPath: string | null
  source?: "panel" | "background" | null
}

export interface CompanionStatus {
  connected: boolean
  /** The .aep open in After Effects (absolute path), if saved. */
  aepPath: string | null
  /** The Murre project that file belongs to, if any. */
  projectId: string | null
  /** True while the panel is busy with a scan or a copy-and-relink (see `activity`). */
  scanning: boolean
  activity?: "scan" | "relink" | null
  progress: { done: number; total: number; compName: string } | null
  /** `panel` can scan; `background` is the hidden helper that is connected while the panel is closed. */
  source?: "panel" | "background" | null
  /** Every After Effects that is connected. The fields above describe the active one. */
  connections?: CompanionConnection[]
  activeId?: number | null
  /** How the most recent scan or relink ended. */
  last: {
    activity?: "scan" | "relink"
    kind: "done" | "failed" | "cancelled"
    message: string | null
    colors: number | null
    expressions: number | null
    comps: number | null
    /** Relink only. */
    copied?: number | null
    reused?: number | null
    failed?: number | null
    items?: number | null
    /** Originals moved to the Trash after being copied. */
    trashed?: number | null
  } | null
}

export type FootageStatus = "inside" | "outside" | "missing" | "sequence"

export interface FootageEntry {
  path: string
  names: string[]
  status: FootageStatus
  /** Project-relative folder an outside file would be copied into. */
  destFolder: string | null
}

export interface FootageView {
  lastScanAt: string | number | null
  assets: FootageEntry[]
  /** Files the Companion copied into the project (newest last). */
  moved: { from: string; to: string; at: string }[]
  skipped: number
}

export interface CompEntry {
  id: number
  name: string
  width: number
  height: number
  frameRate: number
  /** Seconds. */
  duration: number
  folder: string
  main: boolean
}

/** Read-only: the Companion writes `.murre/comps.json`. */
export interface CompsView {
  lastScanAt: string | number | null
  aep: { projectId: string | null; path: string; name: string | null } | null
  comps: CompEntry[]
  skipped: number
}

export interface AerenderInstall {
  path: string
  label: string
  /** The app's version, e.g. "27.1.0"; null when it could not be read. */
  version: string | null
}

/** A detected After Effects install. */
export interface AeInstall {
  /** The aerender path; identifies the install across the app. */
  path: string
  label: string
  version: string | null
}

export interface AeInstalls {
  installs: AeInstall[]
  /** The After Effects chosen earlier (the saved aerender), if any. */
  savedPath: string | null
}

/** What is going on in After Effects right now. */
export interface AeCheck {
  running: boolean
  /** The Companion is connected. */
  connected: boolean
  /** `none` (not running), `empty`, `unsaved`, `saved` or `unknown`. */
  kind: "none" | "empty" | "unsaved" | "saved" | "unknown"
  name: string
  path: string
  /** Where a never-saved project would be saved. */
  desktopDir: string | null
}

/** A Premiere Pro project saved in the project's `04 Premiere & SFX` folder. */
export interface PremiereFile {
  name: string
  /** Relative to the project folder, `/`-separated. */
  path: string
  absolutePath: string
  sizeBytes: number
  /** Unix seconds. */
  modifiedAt: number
  /** False when the file could not be read as a Premiere project (the counts are then zero). */
  readable: boolean
  /** Footage files that exist, files not found, and clips that link to another project. */
  footage: number
  missing: number
  linked: number
}

export interface PremiereCandidate {
  name: string
  /** Full path: sent back to say which projects to collect. */
  path: string
  /** Next to the After Effects project, or in the folder above it. */
  location: "beside" | "inside" | "above"
  size: number
  modified: number | null
  /** Footage files it uses that exist and would be copied. */
  footage: number
  /** Footage files that cannot be found on this Mac. */
  missing: number
  /** Total size of the footage that would be copied. */
  bytes: number
}

export interface VersionCandidate {
  name: string
  size: number
  /** Seconds since 1970, when known. */
  modified: number | null
  /** Same base name as the open project, so probably another version of it. */
  suggested: boolean
}

export interface CreateOutcome {
  /** The new file, relative to the project folder. */
  added: string | null
  /** Where the project that was open before was saved; it was closed. */
  previous: string | null
  message: string | null
}

export interface CompanionInstall {
  installed: boolean
  /** Same version as the one shipped with the app (or a developer's link). */
  current: boolean
  devLink: boolean
  bundleAvailable: boolean
  installedVersion: string | null
  bundledVersion: string | null
  path: string
}

export interface AerenderStatus {
  /** The file the person chose, if any. */
  saved: string | null
  detected: AerenderInstall[]
  active: { path: string; version: string; chosen: boolean } | null
  /** Why nothing usable was found. */
  problem: string | null
}

export interface RenderRequest {
  projectId: string
  compId: number
  /** Absolute path of an existing folder. */
  outputDir: string
  /** Includes the extension, e.g. `Main_v01.mov`. */
  fileName: string
  rsTemplate?: string | null
  omTemplate?: string | null
  /** Use this aerender instead of the automatic choice (one of the detected installs). */
  aerenderPath?: string | null
}

export interface RenderPlan {
  aep: string
  compId: number
  compName: string
  output: string
  warnings: string[]
  totalFrames: number
}

export interface RenderJob {
  id: string
  projectId: string
  compName: string
  output: string
  state: "running" | "finished" | "failed" | "cancelled"
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  frame: number | null
  totalFrames: number
  /** 0–1 estimate from aerender's progress lines; `null` if none were recognised. */
  percent: number | null
  lastLine: string | null
  message: string | null
  logPath: string
  outputExists: boolean
  warnings: string[]
}

export const api = {
  getComps: (projectId: string) => invoke<CompsView>("get_comps", { projectId }),
  getAerenderStatus: () => invoke<AerenderStatus>("get_aerender_status"),
  /** `null` goes back to automatic detection. The file is checked by running `aerender -version`. */
  setAerenderPath: (path: string | null) => invoke<AerenderStatus>("set_aerender_path", { path }),
  renderPreflight: (request: RenderRequest) => invoke<RenderPlan>("render_preflight", { request }),
  startRender: (request: RenderRequest) => invoke<RenderJob>("start_render", { request }),
  getStartup: () => invoke<StartupInfo>("get_startup"),
  /** Turn the login item on or off (installed app only). */
  setLaunchAtLogin: (enabled: boolean) => invoke<void>("set_launch_at_login", { enabled }),
  /** "Not now" on the one-time offer. */
  dismissLoginOffer: () => invoke<void>("dismiss_login_offer"),
  cancelRender: () => invoke<void>("cancel_render"),
  /** Remove the card of a render that has ended. Never touches files. */
  clearRenderJob: () => invoke<void>("clear_render_job"),
  getRenderJob: () => invoke<RenderJob | null>("get_render_job"),
  getRenderLog: (lines: number) => invoke<string[]>("get_render_log", { lines }),
  markProjectOpened: (projectId: string) => invoke<void>("mark_project_opened", { projectId }),
  recentProjects: () => invoke<string[]>("recent_projects"),
  /** How long After Effects was open on each Murre project between two times (ms since the epoch), longest first. */
  timePerProject: (from: number, to: number) => invoke<ProjectTime[]>("time_per_project", { from, to }),
  getGreetingState: () => invoke<string | null>("get_greeting_state"),
  saveGreetingState: (json: string) => invoke<void>("save_greeting_state", { json }),
  getProjectSettings: (projectId: string) => invoke<ProjectSettings>("get_project_settings", { projectId }),
  saveProjectSettings: (projectId: string, settings: ProjectSettings) =>
    invoke<ProjectSettings>("save_project_settings", { projectId, settings: { schemaVersion: 1, ...settings } }),
  getCompanionStatus: () => invoke<CompanionStatus>("get_companion_status"),
  /** Ask the Companion to scan; After Effects must have this project's .aep open. */
  companionScan: (projectId: string) => invoke<void>("companion_scan", { projectId }),
  /** Ask the Companion to copy the project's outside files into it and relink them in After Effects. */
  companionRelink: (projectId: string) => invoke<void>("companion_relink", { projectId }),
  companionCancel: () => invoke<void>("companion_cancel"),
  companionSwitch: (id: number) => invoke<void>("companion_switch", { id }),
  companionPreferProject: (projectId: string) => invoke<void>("companion_prefer_project", { projectId }),
  getFootage: (projectId: string) => invoke<FootageView>("get_footage", { projectId }),
  reconcileProjects: () => invoke<ReconcileReport>("reconcile_projects"),
  /** Point a project whose folder moved at its new folder (the project ID must match). */
  relinkProject: (id: string, path: string) => invoke<ProjectRecord>("relink_project", { id, path }),
  watchProject: (projectId: string) => invoke<void>("watch_project", { projectId }),
  unwatchProject: (projectId: string) => invoke<void>("unwatch_project", { projectId }),
  getExpressions: (projectId: string) => invoke<ExpressionsView>("get_expressions", { projectId }),
  /** Opens the composition in After Effects and selects the layer (and property). Resolves with a note when it could not match exactly. */
  revealInAfterEffects: (
    projectId: string,
    t: { compId: number; comp: string; layerIndex: number | null; layer: string; property: string | null },
  ) =>
    invoke<string | null>("reveal_in_after_effects", {
      projectId,
      compId: t.compId,
      compName: t.comp,
      layerIndex: t.layerIndex,
      layerName: t.layer,
      propertyPath: t.property,
    }),
  packageCheck: (projectId: string) => invoke<PackageCheck>("package_check", { projectId }),
  packageBuild: (projectId: string, options: PackageOptions) => invoke<PackageReport>("package_build", { projectId, options }),
  getNeeds: (projectId: string) => invoke<NeedsView>("get_needs", { projectId }),
  getFonts: (projectId: string) => invoke<FontsView>("get_fonts", { projectId }),
  getColors: (projectId: string) => invoke<ColorsView>("get_colors", { projectId }),
  /** `projectId: null` is the app-wide notes page (stored in the app data folder). */
  getNotes: (projectId: string | null) => invoke<NotesView>("get_notes", { projectId }),
  /** Rejects with a `conflict` error if the notes changed since `expectedRevision`. */
  saveNotes: (projectId: string | null, content: Record<string, unknown>, expectedRevision: number, pageId: string | null = null) =>
    invoke<NotesView>("save_notes", { projectId, content, expectedRevision, pageId }),
  /** Adds an empty page at the end. */
  addNotesPage: (projectId: string | null, expectedRevision: number) =>
    invoke<NotesView>("add_notes_page", { projectId, expectedRevision }),
  /** Removes a page (never the first). */
  deleteNotesPage: (projectId: string | null, pageId: string, expectedRevision: number) =>
    invoke<NotesView>("delete_notes_page", { projectId, pageId, expectedRevision }),
  /** `path` is relative to the project folder; empty lists the project root. */
  listAssets: (projectId: string, path: string) => invoke<AssetListing>("list_assets", { projectId, path }),
  openAsset: (projectId: string, path: string) => invoke<void>("open_asset", { projectId, path }),
  getAeInstalls: () => invoke<AeInstalls>("get_ae_installs"),
  /** Asks After Effects (through the Companion) what is open, before a project is created. */
  checkAfterEffects: () => invoke<AeCheck>("check_after_effects"),
  /**
   * After Effects makes and saves `<name>-v1.aep` itself (via the Companion), starting first if needed. A project
   * that was open is saved and closed. Problems come back in `message`.
   */
  /** Add the project open in After Effects to Murre. Returns at once; progress arrives as `add-project-progress` events. */
  addProjectFromAfterEffects: (name: string, parentDir: string, versions: string[] = [], premiere: string[] = []) =>
    invoke<void>("add_project_from_after_effects", { name, parentDir, versions, premiere }),
  /** Versions and the recent log with file paths removed, to copy when something goes wrong. */
  getDiagnosticReport: () => invoke<string>("get_diagnostic_report"),
  getPremiereProjects: (projectId: string) => invoke<PremiereFile[]>("get_premiere_projects", { projectId }),
  /** Premiere Pro projects beside the open After Effects project or one folder above it (read-only). */
  listPremiereProjects: (path: string) => invoke<PremiereCandidate[]>("list_premiere_projects", { path }),
  /** Other `.aep` files saved next to the open project (`path` is its file), to offer as extra versions. */
  listOtherVersions: (path: string) => invoke<VersionCandidate[]>("list_other_versions", { path }),
  createStarterInAfterEffects: (projectId: string, aerenderPath?: string | null) =>
    invoke<CreateOutcome>("create_starter_in_after_effects", { projectId, aerenderPath: aerenderPath ?? null }),
  getCompanionInstall: () => invoke<CompanionInstall>("get_companion_install"),
  /** Whether After Effects is set to load panels it cannot verify. */
  getCompanionDebugMode: () => invoke<boolean>("get_companion_debug_mode"),
  /** Turns that setting on or off; returns how it is afterwards. */
  setCompanionDebugMode: (enabled: boolean) => invoke<boolean>("set_companion_debug_mode", { enabled }),
  /** Copies the Companion into After Effects' extension folder. */
  installCompanion: () => invoke<CompanionInstall>("install_companion"),
  /**
   * Opens an .aep in After Effects and returns the project-relative path that was opened. Without `path` the
   * current (or highest-version) file is used; `aerenderPath` picks the After Effects version (newest if omitted).
   */
  openInAfterEffects: (projectId: string, path?: string | null, aerenderPath?: string | null) =>
    invoke<string>("open_in_after_effects", { projectId, path: path ?? null, aerenderPath: aerenderPath ?? null }),
  getMediaTools: () => invoke<MediaTools>("get_media_tools"),
  listRenders: (projectId: string) => invoke<RendersListing>("list_renders", { projectId }),
  setRenderApproved: (projectId: string, path: string, approved: boolean) =>
    invoke<RendersListing>("set_render_approved", { projectId, path, approved }),
  probeRender: (projectId: string, path: string) => invoke<MediaInfo>("probe_render", { projectId, path }),
  /** JPEG data URL, or `null` for audio files. */
  renderThumbnail: (projectId: string, path: string) =>
    invoke<string | null>("render_thumbnail", { projectId, path }),
  /** Absolute path to feed to `convertFileSrc`; also grants the webview read access to that one file. */
  renderPlaybackPath: (projectId: string, path: string) =>
    invoke<string>("render_playback_path", { projectId, path }),
  getReferences: (projectId: string | null) => invoke<ReferencesView>("get_references", { projectId }),
  /** Rejects with a `conflict` error if the board changed since `expectedRevision`. */
  saveReferences: (projectId: string | null, canvas: Record<string, unknown>, expectedRevision: number) =>
    invoke<ReferencesView>("save_references", { projectId, canvas, expectedRevision }),
  /** `dataBase64`: raw file bytes, base64 encoded (no data-URL prefix). */
  importReferenceMedia: (projectId: string | null, dataBase64: string) =>
    invoke<ImportedMedia>("import_reference_media", { projectId, dataBase64 }),
  /** Absolute path for `convertFileSrc`; grants the webview read access to that one file. */
  /** Put a reference image in After Effects' active comp (centred), or a new comp when none is active. */
  sendReferenceToAfterEffects: (projectId: string | null, file: string, asShapes = false) =>
    invoke<{ comp: string; created: boolean }>("send_reference_to_after_effects", { projectId, file, asShapes }),
  referenceMediaPath: (projectId: string | null, file: string) =>
    invoke<string>("reference_media_path", { projectId, file }),
  openReferenceMedia: (projectId: string | null, file: string) =>
    invoke<void>("open_reference_media", { projectId, file }),
  getProject: (id: string) => invoke<ProjectRecord>("get_project", { id }),
  setWorkfileNote: (projectId: string, path: string, note: string) =>
    invoke<WorkfileScan>("set_workfile_note", { projectId, path, note }),
  scanWorkfiles: (projectId: string) => invoke<WorkfileScan>("scan_workfiles", { projectId }),
  /** `path` is relative to the project folder; `null` clears the current AEP. */
  setCurrentAep: (projectId: string, path: string | null) =>
    invoke<WorkfileScan>("set_current_aep", { projectId, path }),
  getTasks: (projectId: string) => invoke<Task[]>("get_tasks", { projectId }),
  addTask: (projectId: string, title: string) => invoke<Task[]>("add_task", { projectId, title }),
  setTaskDone: (projectId: string, taskId: string, done: boolean) =>
    invoke<Task[]>("set_task_done", { projectId, taskId, done }),
  deleteTask: (projectId: string, taskId: string) => invoke<Task[]>("delete_task", { projectId, taskId }),
  createProject: (input: NewProjectInput) => invoke<ProjectRecord>("create_project", { input }),
  listProjects: () => invoke<ProjectRecord[]>("list_projects"),
  updateProject: (input: UpdateProjectInput) => invoke<ProjectRecord>("update_project", { input }),
  /** Changes only the deadline (`null` clears it) in the project's `project.json` and the index. */
  setProjectDeadline: (id: string, deadline: string | null) =>
    invoke<ProjectRecord>("set_project_deadline", { id, deadline }),
  /** Events with `from <= date <= to` (`YYYY-MM-DD`, at most about 800 days apart). */
  listEvents: (from: string, to: string) => invoke<CalendarEvent[]>("list_events", { from, to }),
  addEvent: (input: EventInput) => invoke<CalendarEvent>("add_event", { input }),
  updateEvent: (id: string, input: EventInput) => invoke<CalendarEvent>("update_event", { id, input }),
  deleteEvent: (id: string) => invoke<void>("delete_event", { id }),
  listSpaces: () => invoke<Space[]>("list_spaces"),
  createSpace: (name: string, icon: string) => invoke<Space>("create_space", { name, icon }),
  updateSpace: (id: string, name: string, icon: string) => invoke<Space>("update_space", { id, name, icon }),
  /** `ids`: every Space id, in the new order. */
  reorderSpaces: (ids: string[]) => invoke<Space[]>("reorder_spaces", { ids }),
  /** Deletes the Space only; its projects stay and simply have no Space. */
  deleteSpace: (id: string) => invoke<void>("delete_space", { id }),
  /** Files a project into a Space (`null` removes it from its Space). */
  setProjectSpace: (id: string, spaceId: string | null) =>
    invoke<ProjectRecord>("set_project_space", { id, spaceId }),
  /** Removes the project from Murre only; files on disk are never deleted. */
  removeProject: (id: string) => invoke<void>("remove_project", { id }),
  inspectImport: (path: string) => invoke<ImportInspection>("inspect_import", { path }),
  importProject: (path: string, createMetadata: boolean) =>
    invoke<ImportResult>("import_project", { path, createMetadata }),
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  /** Looks for a newer Murre and shows the answer in a native dialog. */
  checkForUpdates: () => invoke<void>("check_for_updates"),
  /** `null` means no profile exists yet (first launch). */
  /** The folder setup new projects are made with, and the kinds of file the editor offers. */
  getFolderSetup: () => invoke<FolderSetup>("get_folder_setup"),
  saveFolderSetup: (template: FolderTemplate) => invoke<FolderSetup>("save_folder_setup", { template }),
  resetFolderSetup: () => invoke<FolderSetup>("reset_folder_setup"),
  getProfile: () => invoke<Profile | null>("get_profile"),
  /** `avatarBase64`: image bytes to set/replace the avatar, or `null` to keep the current one. */
  saveProfile: (name: string, role: string, avatarBase64: string | null) =>
    invoke<Profile>("save_profile", { name, role, avatarBase64 }),
}

/** Whether Murre opens at login. `available` is false in a development build. */
export interface StartupInfo {
  enabled: boolean
  asked: boolean
  available: boolean
}

export interface ProjectTime {
  projectId: string
  name: string
  totalMs: number
  spans: { start: number; end: number }[]
  /** After Effects has this project open right now. */
  live: boolean
}

export interface FolderSpec {
  name: string
  /** Kind ids (see `FolderSetup.kinds`). */
  kinds: string[]
  /** File types typed in by hand, without the dot. */
  extras: string[]
}
export interface FolderTemplate {
  folders: FolderSpec[]
}
export interface FolderKind {
  id: string
  label: string
  exts: string[]
}
export interface FolderSetup {
  template: FolderTemplate
  kinds: FolderKind[]
  isDefault: boolean
}
