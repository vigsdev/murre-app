import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ASSET_FOLDERS, assetSubfolder } from "../../../shared/asset-folders";
import { classifyFootage, destFolderFor } from "./assets-model";
import { parseFolderRules, readFolderRules } from "./folder-rules";
import type { Io } from "./io";

const io: Io = { fs, path };
const project = (folders?: unknown) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murre-folders-"));
  fs.mkdirSync(path.join(root, ".murre"));
  if (folders !== undefined) fs.writeFileSync(path.join(root, ".murre", "folders.json"), typeof folders === "string" ? folders : JSON.stringify(folders));
  return root;
};

describe("parseFolderRules", () => {
  it("reads names and lower-cased extensions", () => {
    expect(parseFolderRules({ schemaVersion: 1, folders: [{ name: " Footage ", exts: ["MP4", "mov"] }, { name: "Notes" }] })).toEqual([
      { folder: "Footage", exts: ["mp4", "mov"] },
      { folder: "Notes", exts: [] },
    ]);
  });
  it("rejects unsafe or repeated names and newer layouts", () => {
    for (const name of ["", "..", ".hidden", "a/b", "a\\b", "x:y"]) expect(parseFolderRules({ folders: [{ name }] })).toBeNull();
    expect(parseFolderRules({ folders: [{ name: "A" }, { name: "a" }] })).toBeNull();
    expect(parseFolderRules({ schemaVersion: 2, folders: [] })).toBeNull();
    expect(parseFolderRules({ folders: "nope" })).toBeNull();
  });
});

describe("a project's own folder setup", () => {
  it("falls back to the default folders when there is no file or it is damaged", () => {
    expect(readFolderRules(io, project())).toEqual(ASSET_FOLDERS);
    expect(readFolderRules(io, project("{ not json"))).toEqual(ASSET_FOLDERS);
    expect(readFolderRules(io, project({ folders: [{ name: "../escape" }] }))).toEqual(ASSET_FOLDERS);
  });
  it("sends files to the project's own folders", () => {
    const root = project({ schemaVersion: 1, folders: [{ name: "Footage", exts: ["mp4", "mov"] }, { name: "Stills", exts: ["png"] }] });
    const rules = readFolderRules(io, root);
    expect(assetSubfolder("a.MP4", rules)).toBe("Footage");
    expect(assetSubfolder("a.wav", rules)).toBeNull();
    expect(destFolderFor("a.png", rules)).toBe("02 Assets/Stills");
    const out = classifyFootage(io, root, [{ id: 1, name: "a.mov", path: "/elsewhere/a.mov", missing: false, kind: "file" } as never]);
    expect(out[0].destFolder).toBe("02 Assets/Footage");
  });
  it("a file type in two folders goes to the first one", () => {
    expect(assetSubfolder("a.png", [{ folder: "A", exts: ["png"] }, { folder: "B", exts: ["png"] }])).toBe("A");
  });
});
