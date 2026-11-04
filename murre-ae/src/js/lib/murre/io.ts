import { fs, path } from "../cep/node";

/** The slice of Node's fs and path that the Companion uses, so it can be tested without CEP. */
export interface Io {
  fs: typeof import("fs");
  path: typeof import("path");
}

/** Node as provided inside the CEP panel (needs `--enable-nodejs`, which the manifest sets). */
export const cepIo = (): Io => ({ fs, path });
