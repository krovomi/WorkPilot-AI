/**
 * Le jeton Figma : écrit dans `.workpilot/.env`, jamais rendu.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../project-store", () => ({ projectStore: { getProject: vi.fn() } }));

import {
	hasFigmaToken,
	sanitizeFigmaToken,
	withFigmaToken,
} from "../figma-handlers";

describe("figma token", () => {
	it("refuse ce qui n'est pas un jeton, sans rien écrire", () => {
		expect(sanitizeFigmaToken("figd_abc-DEF_123456")).toBe("figd_abc-DEF_123456");
		expect(sanitizeFigmaToken("  ")).toBe("");
		expect(sanitizeFigmaToken("tok\nJIRA_API_TOKEN=x")).toBeNull();
		expect(sanitizeFigmaToken(42)).toBeNull();
	});

	it("remplace la ligne, garde les autres, et l'efface sur demande", () => {
		const env = "JIRA_API_TOKEN=j\n# FIGMA_ACCESS_TOKEN=\nGITHUB_REPO=a/b\n";
		const written = withFigmaToken(env, "figd_newtoken1");
		expect(written).toBe(
			"JIRA_API_TOKEN=j\nGITHUB_REPO=a/b\nFIGMA_ACCESS_TOKEN=figd_newtoken1\n",
		);
		expect(hasFigmaToken(written)).toBe(true);
		const cleared = withFigmaToken(written, "");
		expect(hasFigmaToken(cleared)).toBe(false);
		expect(cleared).toContain("JIRA_API_TOKEN=j");
	});
});
