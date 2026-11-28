import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The venv check asks Python for a few modules; a module that the backend's
 * requirements do not install is "missing" on every start, and the app then
 * ran a full `pip install -r requirements.txt` each time it opened. It asked
 * for `google.generativeai` long after the backend stopped depending on it
 * (found by the Electron E2E run against a venv made from requirements.lock).
 */

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: vi.fn(() => "/mock/user/data"), on: vi.fn() },
}));

import { BACKEND_PRESENCE_MODULES } from "../python-env-manager";

/** The distribution that provides each module, as PyPI names it. */
const DISTRIBUTION_OF: Record<string, string> = {
	claude_agent_sdk: "claude-agent-sdk",
	dotenv: "python-dotenv",
	faster_whisper: "faster-whisper",
};

const BACKEND = path.resolve(import.meta.dirname, "../../../../backend");

function requirementNames(file: string): Set<string> {
	const names = new Set<string>();
	for (const raw of readFileSync(path.join(BACKEND, file), "utf-8").split(/\r?\n/)) {
		const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(raw.trim());
		if (match) names.add(match[1].toLowerCase().replace(/[._]/g, "-"));
	}
	return names;
}

describe("the modules the venv check asks for", () => {
	it("each come from a package the backend's requirements install", () => {
		const declared = requirementNames("requirements.txt");
		const locked = requirementNames("requirements.lock");
		for (const module of BACKEND_PRESENCE_MODULES) {
			const distribution = DISTRIBUTION_OF[module];
			expect(distribution, `no distribution known for ${module}`).toBeDefined();
			expect(declared.has(distribution), `${distribution} in requirements.txt`).toBe(true);
			expect(locked.has(distribution), `${distribution} in requirements.lock`).toBe(true);
		}
	});

	it("no longer asks for the Gemini SDK the backend dropped", () => {
		expect(BACKEND_PRESENCE_MODULES).not.toContain("google.generativeai");
		expect(requirementNames("requirements.txt").has("google-generativeai")).toBe(false);
	});
});
