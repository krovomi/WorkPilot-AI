import { describe, expect, it } from "vitest";
import {
	joinProjectPath,
	sanitizeProjectFolderName,
} from "./project-folder-name";

describe("sanitizeProjectFolderName", () => {
	it("kebab-cases a plain name", () => {
		expect(sanitizeProjectFolderName("POC Dotnet New")).toBe("poc-dotnet-new");
		expect(sanitizeProjectFolderName("  spaced   out  ")).toBe("spaced-out");
	});

	it("folds accents instead of deleting them", () => {
		expect(sanitizeProjectFolderName("Café")).toBe("cafe");
		expect(sanitizeProjectFolderName("Élan Vital")).toBe("elan-vital");
		expect(sanitizeProjectFolderName("Prototype Réseau")).toBe(
			"prototype-reseau",
		);
	});

	it("drops characters a folder name cannot carry", () => {
		expect(sanitizeProjectFolderName("api/v2:draft")).toBe("apiv2draft");
		expect(sanitizeProjectFolderName("--edge--case--")).toBe("edge-case");
	});

	it("returns an empty string when nothing usable is left", () => {
		expect(sanitizeProjectFolderName("Проект")).toBe("");
		expect(sanitizeProjectFolderName("   ")).toBe("");
	});
});

describe("joinProjectPath", () => {
	it("keeps the separator the location already uses", () => {
		expect(joinProjectPath("/home/leub/repos", "poc")).toBe(
			"/home/leub/repos/poc",
		);
		expect(joinProjectPath("C:\\Repositories\\Perso", "poc")).toBe(
			"C:\\Repositories\\Perso\\poc",
		);
		expect(joinProjectPath("\\\\wsl.localhost\\Ubuntu\\home", "poc")).toBe(
			"\\\\wsl.localhost\\Ubuntu\\home\\poc",
		);
	});

	it("does not double the separator", () => {
		expect(joinProjectPath("/home/leub/repos/", "poc")).toBe(
			"/home/leub/repos/poc",
		);
		expect(joinProjectPath("C:\\Repositories\\", "poc")).toBe(
			"C:\\Repositories\\poc",
		);
	});
});
