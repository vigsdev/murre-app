/**
 * What the right-click menu shows and does. The choices are not stored here: they are the linked project's own
 * settings (`.murre/settings.json`, the same ones as the app's Settings tab), so this is only a small store
 * that the panel fills in and the menu (built outside React) reads and acts on.
 */
import { useSyncExternalStore } from "react";
import { AUTO_SCAN_CHOICES } from "../murre/settings";

export { AUTO_SCAN_CHOICES };

export interface MenuState {
  /** A Murre project is linked, so there is a settings file to change. Otherwise the menu's own items are greyed out. */
  enabled: boolean;
  /** Shown as ticked when the project does not copy and relink automatically. Shows the Relink button. */
  manualRelink: boolean;
  /** Minutes between automatic scans; 0 is off. */
  autoScan: number;
}

export const NO_PROJECT: MenuState = { enabled: false, manualRelink: false, autoScan: 0 };

/** The settings a menu click changes. */
export interface SettingsPatch {
  copyRelinkOnScan?: boolean;
  autoScanMinutes?: number;
}

export const MENU_IDS = { manualRelink: "manual-relink", auto: (m: number) => `auto-${m}` } as const;

/** What choosing this item does, or null for an item that changes no setting. Choosing the active interval again turns auto-scan off. */
export function menuChoice(state: MenuState, id: string): SettingsPatch | null {
  if (!state.enabled) return null;
  // "Manual" is the opposite of "copy and relink automatically on every scan".
  if (id === MENU_IDS.manualRelink) return { copyRelinkOnScan: state.manualRelink };
  for (const m of AUTO_SCAN_CHOICES) {
    if (id === MENU_IDS.auto(m)) return { autoScanMinutes: state.autoScan === m ? 0 : m };
  }
  return null;
}

let current: MenuState = NO_PROJECT;
let handler: (patch: SettingsPatch) => void = () => {};
const listeners = new Set<() => void>();

export const getMenuState = () => current;

export function setMenuState(next: MenuState) {
  if (next.enabled === current.enabled && next.manualRelink === current.manualRelink && next.autoScan === current.autoScan) return;
  current = next;
  listeners.forEach((l) => l());
}

export const subscribeMenu = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The panel says what to do with a menu choice (write the settings). */
export const setMenuHandler = (fn: (patch: SettingsPatch) => void) => {
  handler = fn;
};
export const runMenuChoice = (id: string) => {
  const patch = menuChoice(current, id);
  if (patch) handler(patch);
};

export const useMenuState = () => useSyncExternalStore(subscribeMenu, getMenuState);
