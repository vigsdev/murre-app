/**
 * Jump to a place found by a scan: open the composition, select the layer and, where possible, the property.
 * Nothing in the project changes except what is selected and which composition is showing.
 *
 * Plain ES3-friendly style, like the other files here (it is compiled for ExtendScript).
 */

export interface RevealResult {
  ok: boolean;
  /** Why it failed, or what could not be matched exactly (the jump still went as far as it could). */
  message: string;
}

const failed = (message: string): RevealResult => ({ ok: false, message: message });

const findCompById = (compId: number, name: string): CompItem | null => {
  const count = app.project.numItems;
  let byName: CompItem | null = null;
  for (let i = 1; i <= count; i++) {
    const item = app.project.item(i);
    if (!(item instanceof CompItem)) continue;
    if (item.id === compId) return item;
    if (!byName && name && item.name === name) byName = item;
  }
  return byName;
};

const clearSelection = (comp: CompItem) => {
  try {
    const props = comp.selectedProperties;
    for (let i = props.length - 1; i >= 0; i--) {
      try {
        props[i].selected = false;
      } catch (e) {
        /* a property that cannot be deselected is left alone */
      }
    }
  } catch (e) {
    /* nothing selected */
  }
  try {
    const layers = comp.selectedLayers;
    for (let i = layers.length - 1; i >= 0; i--) {
      try {
        layers[i].selected = false;
      } catch (e) {
        /* left alone */
      }
    }
  } catch (e) {
    /* nothing selected */
  }
};

/** `propertyPath` is the scan's path below the layer, names joined with " > ". */
export const revealUsage = (compId: number, compName: string, layerIndex: number, layerName: string, propertyPath: string): RevealResult => {
  try {
    const comp = findCompById(compId, compName);
    if (!comp) return failed("The composition “" + compName + "” is not in the open project any more.");
    comp.openInViewer();

    let layer: any = null;
    let note = "";
    if (layerIndex >= 1 && layerIndex <= comp.numLayers) {
      const at = comp.layer(layerIndex);
      if (at && (!layerName || at.name === layerName)) layer = at;
    }
    if (!layer && layerName) {
      for (let i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === layerName) {
          layer = comp.layer(i);
          note = "The layers were reordered since the scan; this is the layer with the same name.";
          break;
        }
      }
    }
    if (!layer) return failed("The layer “" + layerName + "” is not in “" + comp.name + "” any more. Scan again to refresh.");

    clearSelection(comp);
    layer.selected = true;

    if (propertyPath) {
      const names = propertyPath.split(" > ");
      let cur: any = layer;
      for (let i = 0; i < names.length && cur; i++) {
        let next: any = null;
        try {
          next = cur.property(names[i]);
        } catch (e) {
          next = null;
        }
        cur = next;
      }
      if (cur) {
        try {
          cur.selected = true;
        } catch (e) {
          note = note || "The layer is selected, but After Effects would not select the property.";
        }
      } else {
        note = note || "The layer is selected, but the property was not found (it may have been renamed).";
      }
    }
    try {
      app.activate();
    } catch (e) {
      /* the panel's host may not be able to raise the window */
    }
    return { ok: true, message: note };
  } catch (e) {
    return failed(String(e && (e as any).message ? (e as any).message : e));
  }
};
