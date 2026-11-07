/**
 * The "Add this Project to Murre" popup: the project's name and where to make its folder, in one small window. It only collects the
 * answer; the panel that opened it sends it to the Murre app (see lib/murre/add-dialog.ts).
 */
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Button, MantineProvider, TextInput } from "@mantine/core";
import "@mantine/core/styles.css";
import { shadcnCssVariableResolver } from "../main/cssVariablesResolver";
import { panelTheme } from "../main/panel-theme";
import "../main/style.css";
import "./add.scss";
import { csi } from "../lib/utils/bolt";
import { CSEvent } from "../lib/cep/csinterface";
import { ADD_EVENTS, MAX_NAME, parseInit, shortPath } from "../lib/murre/add-dialog";

function send(type: string, data: object) {
  try {
    const ev = new CSEvent(type, "APPLICATION", csi.getApplicationID() as string, csi.getExtensionID() as string);
    ev.data = JSON.stringify(data);
    csi.dispatchEvent(ev);
  } catch {
    /* outside After Effects */
  }
}

const close = () => {
  try {
    csi.closeExtension();
  } catch {
    window.close();
  }
};

function AddDialog() {
  const [name, setName] = useState("");
  const [dir, setDir] = useState<string | null>(null);
  const touched = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  // Say hello; the panel answers with the suggested name.
  useEffect(() => {
    const onInit = (e: { data?: unknown }) => {
      const suggested = parseInit(e.data);
      if (suggested && !touched.current) {
        setName(suggested);
        window.setTimeout(() => input.current?.select(), 0);
      }
    };
    try {
      csi.addEventListener(ADD_EVENTS.init, onInit);
    } catch {
      /* outside After Effects */
    }
    send(ADD_EVENTS.ready, {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      try {
        csi.removeEventListener(ADD_EVENTS.init, onInit, null);
      } catch {
        /* already gone */
      }
    };
  }, []);

  const choose = () => {
    const picked = window.cep?.fs.showOpenDialogEx(false, true, "Choose where to create the project folder", dir ?? "", []);
    const d = picked && picked.err === 0 && picked.data && picked.data[0];
    if (d) setDir(d);
  };

  const ready = !!name.trim() && !!dir;
  const add = () => {
    if (!ready) return;
    send(ADD_EVENTS.result, { name: name.trim(), dir });
    close();
  };

  return (
    <form
      className="dlg"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) add();
        else if (name.trim()) choose();
      }}
    >
      <TextInput
        ref={input}
        label="Project name"
        value={name}
        maxLength={MAX_NAME}
        autoFocus
        onChange={(e) => {
          touched.current = true;
          setName(e.currentTarget.value);
        }}
      />
      <div className="dlg-field">
        <span className="dlg-label">Location</span>
        <button type="button" className="dlg-folder" onClick={choose} title={dir ?? undefined} data-empty={!dir || undefined}>
          {dir ? shortPath(dir) : "Choose folder…"}
        </button>
      </div>
      <div className="dlg-actions">
        <Button variant="subtle" color="gray" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready}>
          Add
        </Button>
      </div>
    </form>
  );
}

document.body.style.backgroundColor = "#1e1e1e";

ReactDOM.createRoot(document.getElementById("app") as HTMLElement).render(
  <React.StrictMode>
    <MantineProvider theme={panelTheme} cssVariablesResolver={shadcnCssVariableResolver} forceColorScheme="dark">
      <AddDialog />
    </MantineProvider>
  </React.StrictMode>,
);
