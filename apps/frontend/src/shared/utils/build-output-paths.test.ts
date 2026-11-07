import { describe, expect, it } from "vitest";
import { isBuildOutputPath } from "./build-output-paths";

describe("isBuildOutputPath", () => {
	it("matches bin/ and obj/ at any depth", () => {
		expect(
			isBuildOutputPath("tests/Rag.Tests.Unit/obj/project.nuget.cache"),
		).toBe(true);
		expect(
			isBuildOutputPath("src/App/bin/Debug/net10.0/App.dll"),
		).toBe(true);
		expect(isBuildOutputPath("obj/x.props")).toBe(true);
		expect(isBuildOutputPath("Bin\\Release\\a.dll")).toBe(true);
	});

	it("keeps sources and lookalike names", () => {
		expect(isBuildOutputPath("toto.txt")).toBe(false);
		expect(isBuildOutputPath("src/binary/reader.ts")).toBe(false);
		expect(isBuildOutputPath("src/objects/model.cs")).toBe(false);
		expect(isBuildOutputPath("scripts/bin")).toBe(false);
	});
});
