/**
 * The project a set of tabs belongs to. A tab reached by a tap on the tab bar
 * is not given the path's `[projectId]` segment by the router, so the tabs'
 * layout, which has it, hands it down to each tab.
 */

import { createContext, useContext } from "react";

export const ProjectIdContext = createContext("");

export function useProjectId(): string {
	return useContext(ProjectIdContext);
}
