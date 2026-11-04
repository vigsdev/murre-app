import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Collapse,
  MantineProvider,
  Progress,
  Stack,
  Text,
  TextInput,
  mergeThemeOverrides,
  rem,
} from "@mantine/core";
// Mantine's component styles. Everything except `@mantine/hooks` needs this import.
import "@mantine/core/styles.css";
import { shadcnCssVariableResolver } from "./cssVariablesResolver";
import { shadcnTheme } from "./theme";
import "./style.css";
import type { RelinkSummary } from "../lib/murre/assets-flow";
import { subscribeBackgroundColor } from "../lib/utils/bolt";
import "./main.scss";
import { suggestName } from "../lib/murre/starter-flow";
import type { VersionFile } from "../lib/murre/bridge-client";
import { useCompanion, type AddProjectState, type LinkState } from "./use-companion";

/** Pick a readable text theme for After Effects' current panel background. */
function themeFor(bg: string): "dark" | "light" {
  const m = bg.match(/\d+/g);
  if (!m) return "dark";
  const [r, g, b] = m.map(Number);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "light" : "dark";
}

/**
 * The shadcn theme, tightened for a narrow panel inside After Effects: smaller type, smaller controls. "Geist" is not bundled, so the
 * font falls back to the system one rather than the browser's default serif.
 */
const theme = mergeThemeOverrides(shadcnTheme, {
  fontFamily: 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  fontSizes: { xs: rem(11), sm: rem(12), md: rem(13), lg: rem(15), xl: rem(17) },
  lineHeights: { xs: rem(15), sm: rem(17), md: rem(19), lg: rem(22) },
  components: {
    Button: Button.extend({ defaultProps: { size: "xs", variant: "filled" } }),
    TextInput: TextInput.extend({ defaultProps: { size: "xs" } }),
    Checkbox: Checkbox.extend({ defaultProps: { size: "xs" } }),
  },
});

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const fileSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const fileDate = (secs: number | null) => (secs ? new Date(secs * 1000).toLocaleDateString() : "");

function AddProjectCard({
  link,
  appLinked,
  state,
  versions,
  onListVersions,
  onAdd,
}: {
  link: LinkState;
  appLinked: boolean;
  state: AddProjectState | null;
  versions: VersionFile[] | null;
  onListVersions: () => void;
  onAdd: (name: string, parentDir: string, versions: string[]) => boolean;
}) {
  const [name, setName] = useState(() => suggestName(link.kind === "none" ? link.path : null));
  const [picked, setPicked] = useState<string[]>([]);
  const busy = !!state && !state.done;
  const openPath = link.kind === "none" ? link.path : null;
  // A saved project may have older versions beside it. Ask the app once per open file; files that look like versions start ticked.
  useEffect(() => {
    if (appLinked && openPath) onListVersions();
  }, [appLinked, openPath]);
  // Most folders hold one project's versions, so all of them start selected.
  useEffect(() => {
    setPicked((versions ?? []).map((v) => v.name));
  }, [versions]);
  const [showList, setShowList] = useState(false);
  const pickedSize = (versions ?? []).filter((v) => picked.includes(v.name)).reduce((n, v) => n + v.size, 0);
  const toggle = (n: string) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  const choose = () => {
    const picked_ = window.cep?.fs.showOpenDialogEx(false, true, "Choose where to create the project folder", "", []);
    const dir = picked_ && picked_.err === 0 && picked_.data && picked_.data[0];
    if (dir) onAdd(name.trim(), dir, picked);
  };
  return (
    <Stack gap="xs" className="sx-block" data-testid="add-project">
      <Text fw={600} fz="sm">
        Add this project to Murre
      </Text>
      <Text size="xs" c="dimmed">
        Makes a new Murre project folder, saves a copy of this project into it, scans it and copies the files it uses into the folder. Your original file is not changed: work in the new copy from now on.
      </Text>
      <TextInput label="Project name" value={name} onChange={(e) => setName(e.currentTarget.value)} disabled={busy} maxLength={100} />
      {versions && versions.length > 0 && (
        <Stack gap={6} data-testid="version-list">
          <Checkbox
            checked={picked.length > 0}
            indeterminate={picked.length > 0 && picked.length < versions.length}
            onChange={(e) => setPicked(e.currentTarget.checked ? versions.map((v) => v.name) : [])}
            disabled={busy}
            label={
              picked.length === 0
                ? `Don't copy the other ${versions.length === 1 ? "version" : `${versions.length} versions`}`
                : picked.length === versions.length
                  ? `Copy ${versions.length === 1 ? "the other version" : `all ${versions.length} other versions`} (${fileSize(pickedSize)})`
                  : `Copy ${picked.length} of ${versions.length} other versions (${fileSize(pickedSize)})`
            }
          />
          <Text size="xs" c="dimmed">
            Other After Effects files saved next to this one. They are copied as they are and keep pointing at their original footage; open one
            in After Effects and use copy and relink to bring its files in.
          </Text>
          <div>
            <Anchor component="button" type="button" size="xs" underline="hover" onClick={() => setShowList((x) => !x)} aria-expanded={showList}>
              {showList ? "Hide list" : "Choose which…"}
            </Anchor>
          </div>
          <Collapse expanded={showList}>
            <ul className="versions">
              {versions.map((v) => (
                <li key={v.name}>
                  <Checkbox
                    checked={picked.includes(v.name)}
                    onChange={() => toggle(v.name)}
                    disabled={busy}
                    label={<span title={v.name}>{v.name}</span>}
                    description={[fileDate(v.modified), fileSize(v.size)].filter(Boolean).join(" · ")}
                  />
                </li>
              ))}
            </ul>
          </Collapse>
        </Stack>
      )}
      <Button variant="filled" fullWidth onClick={choose} disabled={busy || !appLinked || !name.trim()} loading={busy}>
        Choose folder and add…
      </Button>
      {!appLinked && (
        <Text size="xs" c="dimmed">
          Open the Murre app first.
        </Text>
      )}
      {state && (
        <Text size="xs" role="status" c={state.done && !state.ok ? "red" : undefined}>
          {state.text}
        </Text>
      )}
    </Stack>
  );
}

const relinkLine = (r: RelinkSummary): string => {
  const copied = r.report.copied.length + r.report.reused.length;
  const failed = r.report.failed.length ? ` ${plural(r.report.failed.length, "file")} could not be moved.` : "";
  return `Copied ${plural(copied, "file")} into the project and relinked ${plural(r.report.relinkedItems, "footage item")}. Save the project in After Effects to keep the new links.${failed}`;
};


/** The state of the link to a Murre project, in one short line (nothing for a linked project). */
function linkMessage(link: LinkState): { tone: "dimmed" | "yellow" | "red"; text: string } | null {
  switch (link.kind) {
    case "checking":
      return { tone: "dimmed", text: "Checking the open project…" };
    case "outside":
      return { tone: "yellow", text: "Open this panel inside After Effects." };
    case "unsaved":
      return { tone: "yellow", text: "Save the project first, or add it to Murre below." };
    case "none":
      return { tone: "yellow", text: "This file is not in a Murre project. Add it below." };
    case "error":
      return { tone: "red", text: link.message };
    default:
      return null;
  }
}

/** A thin bar with a line of text above it. */
function Bar({ text, done, total }: { text: string; done: number; total: number }) {
  return (
    <Stack gap={4} role="status">
      <Text size="xs">{text}</Text>
      <Progress value={total > 0 ? (Math.min(done, total) / total) * 100 : 100} size="sm" animated={total === 0} />
    </Stack>
  );
}

/** The panel itself: everything the person sees, drawn from what the Companion hook reports. */
function Panel({ bg }: { bg: string }) {
  const { addState, addProject, versions, listVersions, link, compsError, scan, notice, settings, appLinked, appLinkDetail, startScan, cancelScan, assets, relink, startRelink } =
    useCompanion();

  const linked = link.kind === "linked";
  const scanRunning = scan.kind === "running";
  const relinkRunning = relink.kind === "running";
  const outside = (assets?.assets ?? []).filter((a) => a.status === "outside").length;
  const message = linkMessage(link);

  return (
    <div className="sx" style={{ backgroundColor: bg }}>
      <header className="sx-header" role="status" data-linked={appLinked} title={appLinkDetail || undefined}>
        <span className="sx-dot" data-on={appLinked} />
        <Text size="xs" c="dimmed">
          {appLinked ? "App connected" : appLinkDetail ? "App not connected" : "Looking for app…"}
        </Text>
      </header>

      {linked && (
        <Text fw={600} fz="sm" truncate title={link.link.aepPath}>
          {link.link.projectName}
        </Text>
      )}
      {message && (
        <Text size="xs" c={message.tone} role="status">
          {message.text}
        </Text>
      )}

      {(link.kind === "none" || link.kind === "unsaved") && (
        <AddProjectCard link={link} appLinked={appLinked} state={addState} versions={versions} onListVersions={listVersions} onAdd={addProject} />
      )}

      {linked && (
        <Stack gap="xs">
          {scanRunning ? (
            <>
              <Bar
                text={
                  scan.progress && scan.progress.total > 0
                    ? `Scanning ${scan.progress.compName || "…"} (${Math.min(scan.progress.done + 1, scan.progress.total)} of ${scan.progress.total})`
                    : "Starting…"
                }
                done={scan.progress?.done || 0}
                total={scan.progress?.total || 0}
              />
              <Button fullWidth variant="filled" onClick={cancelScan} disabled={scan.cancelling}>
                {scan.cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            </>
          ) : (
            <Button variant="filled" fullWidth onClick={() => void startScan()} disabled={relinkRunning}>
              Scan &amp; organize
            </Button>
          )}
          {scan.kind === "done" && (
            <Stack gap={2} role="status">
              <Text size="xs" c="dimmed">
                {plural(scan.summary.counts.comps, "comp")} · {plural(scan.summary.counts.colors, "color")} · {plural(scan.summary.counts.expressions, "expression")}
                {scan.summary.organized > 0 ? ` · ${plural(scan.summary.organized, "item")} organized (save the project to keep it)` : ""}
              </Text>
              {scan.summary.unmatchedMain.length > 0 && (
                <Text size="xs" c="yellow">
                  {plural(scan.summary.unmatchedMain.length, "previous main comp")} could not be matched and {scan.summary.unmatchedMain.length === 1 ? "was" : "were"} unmarked:{" "}
                  {scan.summary.unmatchedMain.map((m) => m.name).join(", ")}.
                </Text>
              )}
              {scan.summary.warnings.map((w) => (
                <Text key={w} size="xs" c="yellow">
                  {w}
                </Text>
              ))}
            </Stack>
          )}
          {scan.kind === "failed" && (
            <Text size="xs" c="red" role="alert">
              {scan.message}
            </Text>
          )}

          {settings && !settings.copyRelinkOnScan && (
            <>
              {relinkRunning ? (
                <>
                  <Bar
                    text={relink.total > 0 ? `Copying ${relink.name || "…"} (${Math.min(relink.done + 1, relink.total)} of ${relink.total})` : "Starting…"}
                    done={relink.done}
                    total={relink.total}
                  />
                  <Button fullWidth variant="filled" onClick={cancelScan}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button fullWidth variant="filled" onClick={() => void startRelink()} disabled={scanRunning || outside === 0}>
                  Relink assets{outside > 0 ? ` (${outside})` : ""}
                </Button>
              )}
              {relink.kind === "done" && (
                <Text size="xs" c="dimmed" role="status">
                  {relink.summary.report.relinkedItems === 0 && relink.summary.report.failed.length === 0 ? "Nothing needed copying." : relinkLine(relink.summary)}
                </Text>
              )}
              {relink.kind === "failed" && (
                <Text size="xs" c="red" role="alert">
                  {relink.message}
                </Text>
              )}
            </>
          )}
        </Stack>
      )}

      {notice && (
        <Alert color="red" variant="light" role="alert" p="xs">
          <Text size="xs">{notice}</Text>
        </Alert>
      )}
      {compsError && (
        <Text size="xs" c="red" role="alert">
          {compsError}
        </Text>
      )}

    </div>
  );
}

export const App = () => {
  const [bg, setBg] = useState("rgb(40, 44, 52)");

  useEffect(() => {
    if (window.cep) subscribeBackgroundColor(setBg);
  }, []);
  // Keep the page behind the panel the same colour as After Effects, including when the panel is pulled past its edge.
  useEffect(() => {
    document.body.style.backgroundColor = bg;
  }, [bg]);

  return (
    <MantineProvider theme={theme} cssVariablesResolver={shadcnCssVariableResolver} forceColorScheme={themeFor(bg)}>
      <Panel bg={bg} />
    </MantineProvider>
  );
};
