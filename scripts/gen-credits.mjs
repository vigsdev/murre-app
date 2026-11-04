// Builds src/assets/credits.json: every package that ends up in the app (web side from npm, native side from Cargo),
// with its licence and copyright line. Run it after changing dependencies:  node scripts/gen-credits.mjs
import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const out = []

/** The first "Copyright ..." line of a package's licence file, if it has one. */
function copyrightOf(dir) {
  if (!existsSync(dir)) return null
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying|notice)/i.test(f) && !/\.(png|jpg)$/i.test(f))
  if (!file) return null
  try {
    const line = readFileSync(join(dir, file), "utf8").split("\n").find((l) => /^\s*(copyright\b.*\d{4}|©.*\d{4}|\(c\)\s*(copyright\s*)?\d{4})/i.test(l))
    return line ? line.replace(/\s+/g, " ").trim().split(/ \S+\.ttf:/)[0].slice(0, 160) : null
  } catch {
    return null
  }
}

const repoUrl = (r) => {
  const u = typeof r === "string" ? r : r?.url
  return u ? u.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "").replace(/^ssh:\/\/git@/, "https://") : null
}

// Web side. Tools that only build the app (and what only they pull in) are not part of what ships.
const BUILD_ONLY = new Set(["shadcn", "@tailwindcss/vite", "tailwindcss"])
const tree = JSON.parse(execSync("npm ls --omit=dev --all --json", { cwd: root, maxBuffer: 1 << 28 }).toString())
const seen = new Set()
;(function walk(deps) {
  for (const [name, d] of Object.entries(deps ?? {})) {
    if (BUILD_ONLY.has(name) || name.startsWith("@types/")) continue
    if (d.version && !seen.has(`${name}@${d.version}`)) {
      seen.add(`${name}@${d.version}`)
      const dir = d.path ?? join(root, "node_modules", name)
      let pkg = {}
      try {
        pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
      } catch {}
      const lic = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (pkg.licenses?.map((x) => x.type).join(" OR ") ?? "Unknown")
      out.push({ n: name, v: d.version, l: lic, u: pkg.homepage ?? repoUrl(pkg.repository), c: copyrightOf(dir), k: "web" })
    }
    walk(d.dependencies)
  }
})(tree.dependencies)

// Native side: only crates the Mac build really links (normal dependencies, not build or dev tools).
const meta = JSON.parse(execSync("cargo metadata --format-version 1 --locked --filter-platform aarch64-apple-darwin", { cwd: join(root, "src-tauri"), maxBuffer: 1 << 28 }).toString())
const byId = new Map(meta.packages.map((p) => [p.id, p]))
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
const live = new Set()
;(function visit(id) {
  if (live.has(id)) return
  live.add(id)
  for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) visit(d.pkg)
})(meta.resolve.root)
for (const id of live) {
  const p = byId.get(id)
  if (!p || id === meta.resolve.root) continue
  out.push({ n: p.name, v: p.version, l: p.license ?? "See crate", u: p.homepage ?? p.repository ?? null, c: copyrightOf(dirname(p.manifest_path)), k: "native" })
}

out.sort((a, b) => a.n.localeCompare(b.n) || a.v.localeCompare(b.v))
const slim = out.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null)))
writeFileSync(join(root, "src/assets/credits.json"), JSON.stringify(slim))
console.log(`${slim.length} packages (${slim.filter((p) => p.k === "web").length} web, ${slim.filter((p) => p.k === "native").length} native)`)
const kinds = {}
for (const p of slim) kinds[p.l] = (kinds[p.l] ?? 0) + 1
console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v} ${k}`).join("\n"))
