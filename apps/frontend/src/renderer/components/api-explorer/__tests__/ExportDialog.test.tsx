/**
 * Exporting the explored API: what each format holds, which endpoints go in,
 * and what the dialog says when the clipboard refuses.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	type OpenApiSpec,
	useApiExplorerStore,
} from "../../../stores/api-explorer-store";
import {
	buildMarkdownDocs,
	buildPostmanCollection,
	ExportDialog,
} from "../ExportDialog";

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`apiExplorer:${key}`, options ?? {});

const SPEC: OpenApiSpec = {
	openapi: "3.0.0",
	info: { title: "Shop API", version: "1.2.0", description: "Sells things." },
	paths: {
		"/users/{id}": {
			parameters: [] as never,
			get: {
				summary: "Read a user",
				description: "One user by id.",
				tags: ["users"],
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string" },
						description: "The id | or the handle",
					},
					{ name: "X-Tenant", in: "header", example: "acme" },
					{ name: "X-Limit", in: "header", example: 10 },
					{ name: "X-Trace", in: "header" },
				],
				responses: { "200": { description: "The user" }, "404": {} },
			},
			delete: { tags: [], responses: { "204": { description: "Gone" } } },
		},
		"/orders": {
			post: {
				operationId: "createOrder",
				requestBody: {
					content: { "application/json": { example: { sku: "a" } } },
				},
			},
		},
	},
};

type PostmanItem = {
	name: string;
	request: { url: unknown; header: unknown; body: unknown };
};

describe("buildPostmanCollection", () => {
	const collection = buildPostmanCollection(SPEC, "http://localhost:3000");
	const folder = (name: string) =>
		(collection.item as Array<{ name: string; item: PostmanItem[] }>).find(
			(f) => f.name === name,
		);

	it("groups the requests by tag, untagged ones under default", () => {
		expect(collection.info).toMatchObject({
			name: "Shop API",
			description: "Sells things.",
		});
		expect(folder("users")?.item.map((i) => i.name)).toEqual(["Read a user"]);
		// An empty tag list used to drop the request from the collection.
		expect(folder("default")?.item.map((i) => i.name)).toEqual([
			"DELETE /users/{id}",
			"POST /orders",
		]);
		expect(folder("parameters")).toBeUndefined();
	});

	it("writes the address, the path variables and the header examples", () => {
		const { request } = folder("users")?.item[0] ?? {};
		expect(request?.url).toEqual({
			raw: "http://localhost:3000/users/{id}",
			host: ["http://localhost:3000"],
			path: ["users", ":id"],
		});
		expect(request?.header).toEqual([
			{ key: "X-Tenant", value: "acme" },
			{ key: "X-Limit", value: "10" },
			{ key: "X-Trace", value: "" },
		]);
	});

	it("puts the example body of a request in", () => {
		const post = folder("default")?.item[1].request;
		expect(post?.body).toEqual({
			mode: "raw",
			raw: '{\n  "sku": "a"\n}',
			options: { raw: { language: "json" } },
		});
	});

	it("sends an empty body when the request has no example", () => {
		const spec: OpenApiSpec = {
			...SPEC,
			info: { title: "T", version: "1" },
			paths: { "/a": { put: { requestBody: { content: {} } } } },
		};
		const [folderA] = buildPostmanCollection(spec, "").item as Array<{
			item: Array<{ request: { body: { raw: string } } }>;
		}>;
		expect(folderA.item[0].request.body.raw).toBe("{}");
		expect(buildPostmanCollection(spec, "").info.description).toBe("");
	});
});

describe("buildMarkdownDocs", () => {
	const docs = buildMarkdownDocs(SPEC);

	it("documents each endpoint under its first tag", () => {
		expect(docs).toContain("# Shop API\n\nSells things.\n\n**Version:** 1.2.0");
		expect(docs).toContain("## users\n\n### `GET /users/{id}`\n\n**Read a user**\nOne user by id.");
		expect(docs).toContain("## default\n\n### `DELETE /users/{id}`");
		expect(docs).not.toContain("PARAMETERS");
	});

	it("keeps a table cell whole when its text holds a pipe", () => {
		expect(docs).toContain(
			"| `id` | path | string | ✓ | The id \\| or the handle |",
		);
		expect(docs).toContain("| `X-Trace` | header | - | - | - |");
		expect(docs).toContain("| 200 | The user |\n| 404 | - |");
	});

	it("leaves out what an operation does not have", () => {
		const bare = buildMarkdownDocs({
			openapi: "3.0.0",
			info: { title: "Bare", version: "0" },
			paths: { "/ping": { get: {} } },
		});
		expect(bare).toBe(
			"# Bare\n\n**Version:** 0\n\n## default\n\n### `GET /ping`\n\n",
		);
	});
});

describe("ExportDialog", () => {
	const downloads: Array<{ name: string; type: string; text: Promise<string> }> =
		[];
	const writeText = vi.fn();

	beforeEach(() => {
		downloads.length = 0;
		writeText.mockReset();
		useApiExplorerStore.setState({
			environments: [
				{ id: "local", name: "Local", baseUrl: "http://localhost:9000", headers: {} },
			],
			activeEnvironmentId: "local",
		});
		vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
			downloads.push({
				name: "",
				type: (blob as Blob).type,
				text: (blob as Blob).text(),
			});
			return "blob:export";
		});
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
			function (this: HTMLAnchorElement) {
				downloads[downloads.length - 1].name = this.download;
			},
		);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
	});

	afterEach(() => vi.restoreAllMocks());

	const setup = () => {
		const onClose = vi.fn();
		render(<ExportDialog spec={SPEC} onClose={onClose} />);
		return { onClose, user: userEvent.setup() };
	};
	const format = (label: string | RegExp) =>
		screen.getByRole("button", { name: label });

	it("lists every endpoint, all selected, in a named dialog", () => {
		setup();
		expect(screen.getByRole("dialog", { name: t("export.title") })).toBeInTheDocument();
		expect(screen.getAllByRole("checkbox")).toHaveLength(3);
		expect(
			screen.getByText(t("export.endpoints", { selected: 3, total: 3 })),
		).toBeInTheDocument();
	});

	it("downloads the whole contract while everything is selected", async () => {
		const { user } = setup();
		await user.click(format(/OpenAPI 3\.x JSON/));

		expect(downloads[0].name).toBe("openapi.json");
		expect(downloads[0].type).toBe("application/json");
		expect(JSON.parse(await downloads[0].text)).toEqual(SPEC);
	});

	it("downloads only the endpoints kept", async () => {
		const { user } = setup();
		await user.click(screen.getAllByRole("checkbox")[0]);
		await user.click(format(/OpenAPI 3\.x JSON/));

		const exported = JSON.parse(await downloads[0].text) as OpenApiSpec;
		expect(Object.keys(exported.paths["/users/{id}"])).toEqual(["delete"]);
		expect(Object.keys(exported.paths)).toEqual(["/users/{id}", "/orders"]);
	});

	it("drops a path whose endpoints are all left out", async () => {
		const { user } = setup();
		await user.click(screen.getAllByRole("checkbox")[2]);
		await user.click(format(new RegExp(t("export.markdownLabel"))));

		expect(downloads[0].name).toBe("shop-api-api.md");
		expect(await downloads[0].text).not.toContain("/orders");
	});

	it("exports a Postman collection on the active environment's address", async () => {
		const { user } = setup();
		await user.click(format(/Postman Collection v2\.1/));

		expect(downloads[0].name).toBe("collection.postman_collection.json");
		expect(await downloads[0].text).toContain(
			'"raw": "http://localhost:9000/orders"',
		);
	});

	it("selects none, then all, and blocks an empty export", async () => {
		const { user } = setup();
		await user.click(screen.getByRole("button", { name: t("export.deselectAll") }));
		expect(format(/OpenAPI 3\.x JSON/)).toBeDisabled();
		expect(format(t("export.copySpec"))).toBeDisabled();

		await user.click(screen.getByRole("button", { name: t("export.selectAll") }));
		expect(screen.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
	});

	it("copies the contract, then says so for a moment", async () => {
		vi.useFakeTimers();
		try {
			writeText.mockResolvedValue(undefined);
			render(<ExportDialog spec={SPEC} onClose={vi.fn()} />);
			await act(async () => format(t("export.copySpec")).click());

			expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(SPEC);
			expect(screen.getByText(t("export.copied"))).toBeInTheDocument();
			await act(async () => vi.advanceTimersByTime(2000));
			expect(screen.getByText(t("export.copySpec"))).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("says when the clipboard refused the copy", async () => {
		const { user } = setup();
		// user-event installs its own clipboard; put the refusing one back.
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
			configurable: true,
		});
		await user.click(format(t("export.copySpec")));

		expect(screen.getByRole("alert")).toHaveTextContent(t("export.copyFailed"));
		expect(screen.queryByText(t("export.copied"))).not.toBeInTheDocument();
	});

	it("closes", async () => {
		const { onClose, user } = setup();
		await user.click(screen.getByRole("button", { name: t("aria.close") }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("puts an endpoint back once ticked again", async () => {
		const { user } = setup();
		const [first] = screen.getAllByRole("checkbox");
		await user.click(first);
		await user.click(first);
		await user.click(format(/OpenAPI 3\.x JSON/));
		expect(JSON.parse(await downloads[0].text)).toEqual(SPEC);
	});

	it("falls back to the first environment, and to no address without one", async () => {
		useApiExplorerStore.setState({ activeEnvironmentId: "gone" });
		const { user } = setup();
		await user.click(format(/Postman Collection v2\.1/));
		expect(await downloads[0].text).toContain('"raw": "http://localhost:9000/orders"');

		useApiExplorerStore.setState({ environments: [] });
		await user.click(format(/Postman Collection v2\.1/));
		expect(await downloads[1].text).toContain('"raw": "/orders"');
	});

	it("exports a contract that has no paths at all", async () => {
		const bare = { openapi: "3.0.0", info: { title: "Bare", version: "0" } } as OpenApiSpec;
		render(<ExportDialog spec={bare} onClose={vi.fn()} />);
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(buildPostmanCollection(bare, "").item).toEqual([]);
		expect(buildMarkdownDocs(bare)).toBe("# Bare\n\n**Version:** 0\n");
	});

	it("hides the endpoint list of a spec without endpoints", () => {
		render(
			<ExportDialog
				spec={{ ...SPEC, paths: {} }}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
	});
});
