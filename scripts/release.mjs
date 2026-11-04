#!/usr/bin/env node
// Gets a release ready: sets the new version everywhere, commits, and makes the tag that starts the release build.
//
//   npm run release -- 0.2.0 "Fixes the calendar swipe."
//
// The notes become the release notes and the text in Murre's update dialog. Nothing is pushed; push it yourself
// with `git push --follow-tags` (see RELEASING.md).
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const [version, ...rest] = process.argv.slice(2)
const notes = rest.join(" ").trim()

const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim()

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('Give the version as 1.2.3, for example: npm run release -- 0.2.0 "What changed."')
if (!notes) fail('Add a line about what changed, for example: npm run release -- 0.2.0 "Fixes the calendar swipe."')

const confPath = "src-tauri/tauri.conf.json"
const current = JSON.parse(readFileSync(confPath, "utf8")).version
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number))
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
if (!newer(version, current)) fail(`${version} isn't newer than the current version, ${current}. The updater only offers newer versions.`)

if (run("git", ["status", "--porcelain"])) fail("There are uncommitted changes. Commit or stash them first, so the release has only what you meant.")
if (run("git", ["tag", "--list", `v${version}`])) fail(`The tag v${version} already exists.`)

/** Replaces the first match of `pattern` in a file's text, or stops if it isn't there. */
function bump(path, pattern) {
  const text = readFileSync(path, "utf8")
  const out = text.replace(pattern, `$1"${version}"`)
  if (out === text) fail(`Couldn't find the version in ${path}. Nothing was changed.`)
  return [path, out]
}

// Work out every change first, so nothing is written unless all of them can be made.
const cargoPath = "src-tauri/Cargo.toml"
const lockPath = "src-tauri/Cargo.lock"
const edits = [
  // The version the updater compares.
  bump(confPath, /^(\s*"version": )"[^"]+"/m),
  // Only the package's own version, in [package].
  bump(cargoPath, /^(\[package\][\s\S]*?^version = )"[^"]+"/m),
  bump(lockPath, /^(\[\[package\]\]\nname = "murre"\nversion = )"[^"]+"/m),
]
const files = [...edits.map(([path]) => path), "package.json", "package-lock.json"]

try {
  for (const [path, text] of edits) writeFileSync(path, text)
  run("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"])
  run("git", ["add", ...files])
  run("git", ["commit", "-m", `Release v${version}`, "-m", notes])
  run("git", ["tag", "-a", `v${version}`, "-m", notes])
} catch (e) {
  // The working tree was clean when we started, so putting these files back loses nothing.
  if (!run("git", ["tag", "--list", `v${version}`])) {
    try {
      run("git", ["reset", "--quiet", "--", ...files])
      run("git", ["checkout", "--", ...files])
    } catch {}
  }
  fail(`The release didn't finish, and the version changes were undone.\n\n${e.message}`)
}

console.log(`Ready: commit and tag v${version}.`)
console.log("Push both to start the build:  git push --follow-tags")
