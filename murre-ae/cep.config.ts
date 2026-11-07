import type { CEP_Config } from "vite-cep-plugin";
import { version } from "./package.json";

// The ZXP is signed with a self-signed certificate that is made fresh on every signed build, so this password only
// protects that throwaway certificate. It is kept out of the repo anyway: set it when signing, e.g.
//   MURRE_ZXP_PASSWORD='any-password' npm run bundle:signed
// This file is also bundled into the panel and into the ExtendScript that runs inside After Effects (through
// src/shared/shared.ts), where there is no `process`. `typeof` is the one check that doesn't throw there.
const env: Record<string, string | undefined> = typeof process !== "undefined" && process.env ? process.env : {};
const zxpPassword = env.MURRE_ZXP_PASSWORD;
if (env.ZXP_PACKAGE === "true" && !zxpPassword) {
  throw new Error(
    "Set MURRE_ZXP_PASSWORD to sign the Companion. Any password works: the certificate is made fresh on each build.",
  );
}

const config: CEP_Config = {
  version,
  id: "com.murre.cep", 
  displayName: "Murre", 
  symlink: "local",
  port: 3000,
  servePort: 5000,
  startingDebugPort: 8860,
  extensionManifestVersion: 6.0,
  requiredRuntimeVersion: 9.0,
  hosts: [
    { name: "AEFT", version: "[0.0,99.9]" }, 
  ],

  type: "Panel",
  iconDarkNormal: "./src/assets/light-icon.png",
  iconNormal: "./src/assets/dark-icon.png",
  iconDarkNormalRollOver: "./src/assets/light-icon.png",
  iconNormalRollOver: "./src/assets/dark-icon.png",
  parameters: ["--v=0", "--enable-nodejs", "--mixed-context"],
  width: 500,
  height: 550,

  panels: [
    {
      mainPath: "./main/index.html",
      name: "main",
      panelDisplayName: "Murre", 
      autoVisible: true,
      width: 600,
      height: 650,
    },
    {
      // Hidden helper that starts with After Effects and keeps the link to the Murre app alive for
      // things that must work without the panel being open (creating a new project's file).
      mainPath: "./background/index.html",
      name: "background",
      type: "Custom",
      autoVisible: false,
      startOnEvents: ["com.adobe.csxs.events.ApplicationInitialized"],
      width: 100,
      height: 100,
    },
    {
      // "Add this Project to Murre": a small popup asking for the project's name and folder (src/js/lib/murre/add-dialog.ts).
      mainPath: "./add/index.html",
      name: "add",
      panelDisplayName: "Add to Murre",
      type: "ModalDialog",
      autoVisible: true,
      width: 380,
      height: 210,
    },
  ],
  build: {
    jsxBin: "off",
    sourceMap: true,
  },
  zxp: {
    country: "IN",
    province: "TN",
    org: "Vigs",
    password: zxpPassword ?? "",
    tsa: [
      "http://timestamp.digicert.com/", // Windows Only
      "http://timestamp.apple.com/ts01", // MacOS Only
    ],
    allowSkipTSA: false,
    sourceMap: false,
    jsxBin: "off",
  },
  installModules: [],
  copyAssets: [],
  copyZipAssets: [],
};
export default config;
