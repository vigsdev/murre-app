import { company, displayName, version } from "../../../shared/shared";
import { dispatchTS, openLinkInBrowser } from "./bolt";
import { AUTO_SCAN_CHOICES, getMenuState, MENU_IDS, runMenuChoice, subscribeMenu } from "./panel-prefs";
import { keyRegisterOverride, dropDisable } from "./cep";

const buildFlyoutMenu = () => {
  const menu = `<Menu>
  <MenuItem Id="info" Label="${displayName} ${version}" Enabled="false" Checked="false"/>
  <MenuItem Id="website" Label="by ${company}" Enabled="false" Checked="false"/>
  <MenuItem Label="---" />
  <MenuItem Id="refresh" Label="Refresh" Enabled="true" Checked="false"/>
  </Menu>`;

  interface FlyoutMenuEvent {
    data:
      | {
          menuId: string;
        }
      | string;
  }
  const flyoutHandler = (event: FlyoutMenuEvent) => {
    let menuId;
    if (typeof event.data === "string") {
      try {
        //? On build the events come in garbled string which requires some replacing and then parsing to get the data
        menuId = JSON.parse(
          event.data.replace(/\$/g, "").replace(/\=2/g, ":")
        ).menuId;
      } catch (e) {
        console.error(e);
      }
    } else {
      menuId = event.data.menuId;
    }
    if (menuId === "website") {
      // openLinkInBrowser(homePage);
    } else if (menuId === "info") {
      // openLinkInBrowser(productPage);
    } else if (menuId === "refresh") {
      location.reload();
    }
  };

  window.__adobe_cep__.invokeSync("setPanelFlyoutMenu", menu);
  window.__adobe_cep__.addEventListener(
    "com.adobe.csxs.events.flyoutMenuClicked",
    flyoutHandler
  );
};

/**
 * Right-click menu: Reload, Force Reload and two project settings as checkboxes. The menu is drawn again from
 * scratch after every change, because after a click it cannot be trusted to untick the other intervals itself.
 */
const buildContextMenu = () => {
  const s = getMenuState();
  const item = (id: string, label: string, checked = false, enabled = true) => ({ label, enabled, checked, checkable: !id.startsWith("c-"), id });
  const menuObj = {
    menu: [
      item("c-0", "Reload"),
      item("c-1", "Force Reload"),
      { label: "---", enabled: true, checked: false, checkable: false, id: "c-sep" },
      item(MENU_IDS.manualRelink, "Relink assets manually", s.enabled && s.manualRelink, s.enabled),
      { label: "---", enabled: true, checked: false, checkable: false, id: "c-sep-2" },
      ...AUTO_SCAN_CHOICES.map((m) => item(MENU_IDS.auto(m), `Scan every ${m} min`, s.enabled && s.autoScan === m, s.enabled)),
    ],
  };
  window.__adobe_cep__.invokeAsync("setContextMenuByJSON", JSON.stringify(menuObj), (id: string) => {
    if (id === "c-0") return location.reload();
    if (id === "c-1") return process.abort();
    runMenuChoice(id);
    // Draw it again once the click has finished, so what is ticked is what is really set.
    setTimeout(buildContextMenu, 0);
  });
};

export const initializeCEP = () => {
  buildFlyoutMenu();
  buildContextMenu();
  // The settings can also change from the app or a different project: keep the ticks right.
  subscribeMenu(() => setTimeout(buildContextMenu, 0));
  // keyRegisterOverride(); // Capture all Key Events Possible (many limitations on MacOS)
  dropDisable(); // to prevent drop files on panel and taking over
};
