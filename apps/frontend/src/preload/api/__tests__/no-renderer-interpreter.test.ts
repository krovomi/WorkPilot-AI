/**
 * The renderer never chooses the interpreter a feature runs: the main process
 * configures every Python-backed service with the managed Python. These tests
 * pin the removal of the `<feature>:configure` channels, which took a
 * `pythonPath` from the renderer and ran it on the next request.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { createElectronAPI } from "..";

const SRC = path.resolve(__dirname, "../../..");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__tests__" ? [] : sources(full);
		}
		return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)
			? [full]
			: [];
	});
}

describe("no interpreter from the renderer", () => {
	it("has no channel constant that configures a service", () => {
		expect(
			Object.values(IPC_CHANNELS).filter((channel) =>
				channel.endsWith(":configure"),
			),
		).toEqual([]);
	});

	it("registers no handler and invokes no channel ending in :configure", () => {
		const offenders = [
			...sources(path.join(SRC, "main")),
			...sources(path.join(SRC, "preload")),
		].filter((file) => /["'`][\w-]+:configure["'`]/.test(readFileSync(file, "utf8")));
		expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
	});

	it("exposes no configure method that takes a Python path", () => {
		const api = createElectronAPI() as unknown as Record<string, unknown>;
		expect(
			Object.keys(api).filter((name) => /^configure[A-Z]/.test(name)),
		).toEqual([]);
	});
});
