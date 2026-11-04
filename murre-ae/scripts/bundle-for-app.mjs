// Copies the built Companion (dist/cep) into the desktop app, which ships it and installs it for the user.
// Usage: npm run bundle            (unsigned folder, for development; writes ../src-tauri/companion-bundle)
//        npm run bundle:signed     (builds and signs the .zxp, then ships that file; use this for a release)
//        node scripts/bundle-for-app.mjs [--signed] <target-dir>
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "dist", "cep");
const signed = process.argv.includes("--signed");
const to = resolve(process.argv.slice(2).find((a) => a !== "--signed") || join(root, "..", "src-tauri", "companion-bundle"));

if (signed) {
  // The signed package goes in as one file. The app unpacks it as it is, because the signature covers every file in it.
  const zxp = join(root, "dist", "zxp", "com.murre.cep.zxp");
  if (!existsSync(zxp)) {
    console.error("No signed package yet: run `npm run zxp` first (or use `npm run bundle:signed`).");
    process.exit(1);
  }
  const inside = spawnSync("unzip", ["-p", zxp, "CSXS/manifest.xml"], { encoding: "utf8" });
  if (inside.status !== 0 || !inside.stdout.includes("com.murre.cep.background")) {
    console.error("The signed package is not a Murre Companion with the background extension.");
    process.exit(1);
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  copyFileSync(zxp, join(to, "com.murre.cep.zxp"));
  console.log(`Signed Companion copied to ${to}`);
  process.exit(0);
}

if (!existsSync(join(from, "CSXS", "manifest.xml"))) {
  console.error("Nothing built yet: run `npm run build` first.");
  process.exit(1);
}
const manifest = readFileSync(join(from, "CSXS", "manifest.xml"), "utf8");
if (!manifest.includes("com.murre.cep.background")) {
  console.error("The build does not include the background extension.");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, {
  recursive: true,
  dereference: true,
  filter: (src) => !/(^|\/)(\.debug|\.DS_Store|node_modules)$/.test(src) && !src.endsWith(".map"),
});
console.log(`Companion copied to ${to}`);
