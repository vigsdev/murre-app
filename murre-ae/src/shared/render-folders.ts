/**
 * The Murre project folders a render can go into, shared by the panel (the P / R / D button) and the ExtendScript side
 * (setting the Render Queue item's output). Plain ES3-friendly code: it is compiled for ExtendScript as well.
 */

export type RenderKind = "pre" | "render" | "deliverable";

export const RENDER_KINDS: RenderKind[] = ["pre", "render", "deliverable"];

export const RENDER_FOLDERS: { [k in RenderKind]: string } = {
  pre: "05 Pre-Renders",
  render: "06 Renders",
  deliverable: "07 Deliverables",
};

/** The letter on the button. */
export const RENDER_LETTERS: { [k in RenderKind]: string } = { pre: "P", render: "R", deliverable: "D" };

/** P → R → D → P. */
export const nextRenderKind = (k: RenderKind): RenderKind => (k === "pre" ? "render" : k === "render" ? "deliverable" : "pre");

/**
 * A file name that is not taken yet: "Main.mov", then "Main 2.mov", "Main 3.mov"… Image sequence names (with [###])
 * are returned unchanged, since After Effects numbers their frames itself.
 */
export function freeFileName(name: string, taken: (candidate: string) => boolean): string {
  if (/\[#+\]/.test(name) || !taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = base + " " + n + ext;
    if (!taken(candidate)) return candidate;
  }
  return name;
}
