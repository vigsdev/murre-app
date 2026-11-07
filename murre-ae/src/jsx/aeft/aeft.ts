import {
  helloVoid,
  helloError,
  helloStr,
  helloNum,
  helloArrayStr,
  helloObj,
} from "../utils/samples";
export { helloError, helloStr, helloNum, helloArrayStr, helloObj, helloVoid };
import { dispatchTS } from "../utils/utils";
export { getAepInfo, listComps, scanComp, scanFonts } from "./scan";
export { listFootage, relinkFootage } from "./footage";
export { organizeProject } from "./organize";
export { createStarter, inspectAe, importImage, saveProjectAs } from "./starter";

export const helloWorld = () => {
  alert("Hello from After Effects!");
  app.project.activeItem;
};
export { revealUsage } from "./reveal";
export { addActiveCompToQueue } from "./render-queue";
