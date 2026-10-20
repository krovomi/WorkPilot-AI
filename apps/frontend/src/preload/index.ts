import { contextBridge } from "electron";
import { createElectronAPI } from "./api";
import { isLinux, isMacOS, isUnix, isWindows } from "../shared/platform";

// Create the unified API by combining all domain-specific APIs
const electronAPI = createElectronAPI();

// Expose to renderer via contextBridge
contextBridge.exposeInMainWorld("electronAPI", electronAPI);

// Expose debug flag for debug logging
contextBridge.exposeInMainWorld("DEBUG", process.env.DEBUG === "true");

// Expose platform information for platform-specific behavior (e.g., PTY resize timing)
contextBridge.exposeInMainWorld("platform", {
	isWindows: isWindows(),
	isMacOS: isMacOS(),
	isLinux: isLinux(),
	isUnix: isUnix(),
});
