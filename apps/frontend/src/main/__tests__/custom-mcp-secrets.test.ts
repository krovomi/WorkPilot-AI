/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { MASKED_SECRET } from "../../shared/constants";
import type { CustomMcpServer } from "../../shared/types";
import {
	maskCustomMcpServers,
	parseCustomMcpServers,
	unmaskCustomMcpServers,
} from "../custom-mcp-secrets";

const COMMAND: CustomMcpServer = {
	id: "fs",
	name: "Files",
	type: "command",
	command: "npx",
	env: { TOKEN: "tok_stored" },
};

describe("maskCustomMcpServers", () => {
	it("masks a value that is not text, and leaves a server without values as it is", () => {
		const odd = { ...COMMAND, env: { COUNT: 3 } } as unknown as CustomMcpServer;
		const bare: CustomMcpServer = { id: "b", name: "B", type: "http", url: "https://b" };

		expect(maskCustomMcpServers([odd, bare])).toEqual([
			{ ...COMMAND, env: { COUNT: MASKED_SECRET } },
			bare,
		]);
	});

	it("keeps only the scheme of a bearer value, whatever its case", () => {
		const [server] = maskCustomMcpServers([
			{ ...COMMAND, type: "http", url: "https://a", headers: { auth: "bearer abc" } },
		]);

		expect(server.headers).toEqual({ auth: `bearer ${MASKED_SECRET}` });
	});
});

describe("unmaskCustomMcpServers", () => {
	it("restores a masked value of the same command with the same arguments", () => {
		const masked = { ...COMMAND, env: { TOKEN: MASKED_SECRET } };

		expect(unmaskCustomMcpServers([masked], [COMMAND])).toEqual([COMMAND]);
		expect(
			unmaskCustomMcpServers([{ ...masked, command: "node" }], [COMMAND])[0].env,
		).toEqual({});
		expect(
			unmaskCustomMcpServers([{ ...masked, type: "http" }], [COMMAND])[0].env,
		).toEqual({});
	});

	it("leaves out a value that is not text", () => {
		const sent = { ...COMMAND, env: { TOKEN: 3, KEPT: "x" } } as unknown as CustomMcpServer;

		expect(unmaskCustomMcpServers([sent], [])[0].env).toEqual({ KEPT: "x" });
	});

	it("leaves out a mask whose stored value is not text", () => {
		const stored = { ...COMMAND, env: { TOKEN: 3 } } as unknown as CustomMcpServer;
		const sent = { ...COMMAND, env: { TOKEN: MASKED_SECRET } };

		expect(unmaskCustomMcpServers([sent], [stored])[0].env).toEqual({});
	});
});

describe("values that are not a map", () => {
	it("are neither shown nor written", () => {
		const odd = { ...COMMAND, env: "TOKEN=tok" } as unknown as CustomMcpServer;

		expect(maskCustomMcpServers([odd])[0].env).toBeUndefined();
		expect(unmaskCustomMcpServers([odd], [COMMAND])[0].env).toBeUndefined();
	});
});

describe("parseCustomMcpServers", () => {
	it("reads the stored list, and nothing from a value that is not one", () => {
		expect(parseCustomMcpServers(JSON.stringify([COMMAND]))).toEqual([COMMAND]);
		expect(parseCustomMcpServers(undefined)).toEqual([]);
		expect(parseCustomMcpServers("{not json")).toEqual([]);
		expect(parseCustomMcpServers('{"id":"fs"}')).toEqual([]);
	});
});
