/**
 * @vitest-environment jsdom
 */
/**
 * Adding and editing a custom MCP server: a command or an HTTP endpoint, its
 * id taken from its name, a bearer token and extra headers.
 */
import type { CustomMcpServer } from "@shared/types";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomMcpDialog } from "../CustomMcpDialog";

const onSave = vi.fn();
const onOpenChange = vi.fn();
const openExternal = vi.fn();

function show(server: CustomMcpServer | null = null, existingIds: string[] = []) {
	const props = { open: true, onOpenChange, onSave, existingIds };
	const view = render(<CustomMcpDialog {...props} server={server} />);
	return {
		reopen: (next: CustomMcpServer | null) => {
			view.rerender(<CustomMcpDialog {...props} open={false} server={next} />);
			view.rerender(<CustomMcpDialog {...props} server={next} />);
		},
	};
}

const save = (name: RegExp | string = "Add Server") => screen.getByRole("button", { name });

async function typeName(name: string) {
	await userEvent.type(screen.getByLabelText("Name"), name);
}

async function chooseHttp() {
	await userEvent.click(screen.getByRole("radio", { name: "HTTP" }));
}

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(globalThis.electronAPI, { openExternal });
});

describe("a new command server", () => {
	it("saves its name, id, command and arguments once both are typed", async () => {
		show();
		expect(screen.getByRole("heading", { name: "Add Custom Server" })).toBeTruthy();
		expect(save().hasAttribute("disabled")).toBe(true);
		await typeName("My Docs Server!");
		expect(screen.getByText("ID: my-docs-server")).toBeTruthy();
		await userEvent.type(screen.getByLabelText("Arguments"), "-y  @acme/docs-mcp");
		await userEvent.type(screen.getByLabelText(/^Description/), "  Docs  ");
		await userEvent.click(save());

		expect(onSave).toHaveBeenCalledWith({
			id: "my-docs-server",
			name: "My Docs Server!",
			type: "command",
			description: "Docs",
			command: "npx",
			args: ["-y", "@acme/docs-mcp"],
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("needs a command", async () => {
		show();
		await typeName("Docs");
		await userEvent.clear(screen.getByLabelText("Command"));
		expect(save().hasAttribute("disabled")).toBe(true);
		await userEvent.type(screen.getByLabelText("Command"), "uvx");
		expect(save().hasAttribute("disabled")).toBe(false);
	});

	it("refuses a name with no letter or digit, which would give an empty id", async () => {
		show();
		await typeName("!!!");
		expect(screen.getByText("ID: ...")).toBeTruthy();
		await userEvent.click(save());
		expect(screen.getByText("The name needs at least one letter or digit")).toBeTruthy();
		expect(onSave).not.toHaveBeenCalled();
		await typeName("a");
		expect(screen.queryByText("The name needs at least one letter or digit")).toBeNull();
	});

	it("refuses an id that is already taken, and clears the error once the name changes", async () => {
		show(null, ["github", "docs"]);
		await typeName("GitHub");
		await userEvent.click(save());
		expect(screen.getByText("A server with this ID already exists")).toBeTruthy();
		expect(onSave).not.toHaveBeenCalled();
		await typeName(" mirror");
		expect(screen.queryByText("A server with this ID already exists")).toBeNull();
		await userEvent.click(save());
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "github-mirror" }));
	});

	it("closes on Cancel without saving", async () => {
		show();
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onSave).not.toHaveBeenCalled();
	});
});

describe("a new HTTP server", () => {
	it("needs a URL, and sends the token as a bearer Authorization header", async () => {
		show();
		await typeName("Remote");
		await chooseHttp();
		expect(screen.queryByLabelText("Command")).toBeNull();
		expect(save().hasAttribute("disabled")).toBe(true);
		await userEvent.type(screen.getByLabelText("URL"), "https://mcp.acme.dev/mcp");
		await userEvent.type(screen.getByLabelText(/^Authentication Token/), "  tok-0000  ");
		await userEvent.click(save());
		expect(onSave).toHaveBeenCalledWith({
			id: "remote",
			name: "Remote",
			type: "http",
			description: undefined,
			url: "https://mcp.acme.dev/mcp",
			headers: { Authorization: "Bearer tok-0000" },
		});
	});

	it("sends no headers when none are set", async () => {
		show();
		await typeName("Open");
		await chooseHttp();
		await userEvent.type(screen.getByLabelText("URL"), "https://open.example/mcp");
		await userEvent.click(save());
		expect(onSave.mock.calls[0][0].headers).toBeUndefined();
	});

	it.each([
		["https://api.githubcopilot.com/mcp", "Create GitHub PAT", "https://github.com/settings/tokens"],
		["https://x.googleapis.com/mcp", "Create Google Credentials", "https://console.cloud.google.com/apis/credentials"],
		["https://mcp.anthropic.com", "Create Anthropic API Key", "https://console.anthropic.com/settings/keys"],
		["https://mcp.openai.com", "Create OpenAI API Key", "https://platform.openai.com/api-keys"],
	])("points %s to where its key is made", async (url, link, target) => {
		show();
		await chooseHttp();
		await userEvent.type(screen.getByLabelText("URL"), url);
		await userEvent.click(screen.getByRole("link", { name: link }));
		expect(openExternal).toHaveBeenCalledWith(target);
	});

	it("adds extra headers, never shows their value, and removes them", async () => {
		show();
		await typeName("Remote");
		await chooseHttp();
		await userEvent.type(screen.getByLabelText("URL"), "https://mcp.acme.dev");
		await userEvent.click(screen.getByRole("button", { name: /Additional Headers/ }));
		const add = screen.getByRole("button", { name: "Add" });
		expect(add.hasAttribute("disabled")).toBe(true);
		await userEvent.type(screen.getByPlaceholderText("Header Name"), " X-Api-Key ");
		await userEvent.type(screen.getByPlaceholderText("Header Value"), "secret-value-0000");
		await userEvent.click(add);
		await userEvent.type(screen.getByPlaceholderText("Header Name"), "X-Team");
		await userEvent.type(screen.getByPlaceholderText("Header Value"), "core");
		await userEvent.click(screen.getByRole("button", { name: "Add" }));

		expect(screen.queryByText(/secret-value/)).toBeNull();
		expect(screen.getByText("X-Api-Key:")).toBeTruthy();
		expect((screen.getByPlaceholderText("Header Name") as HTMLInputElement).value).toBe("");

		await userEvent.click(screen.getByRole("button", { name: "Remove header X-Team" }));
		expect(screen.queryByText("X-Team:")).toBeNull();
		await userEvent.click(save());
		expect(onSave.mock.calls[0][0].headers).toEqual({ "X-Api-Key": "secret-value-0000" });

		await userEvent.click(screen.getByRole("button", { name: /Additional Headers/ }));
		expect(screen.queryByPlaceholderText("Header Name")).toBeNull();
	});
});

describe("editing a server", () => {
	const REMOTE: CustomMcpServer = {
		id: "remote",
		name: "Remote",
		type: "http",
		url: "https://mcp.acme.dev",
		headers: { Authorization: "Bearer old-0000", "X-Team": "core" },
	};

	it("fills the form, keeps the id and shows the extra headers", async () => {
		show(REMOTE, ["remote"]);
		expect(screen.getByRole("heading", { name: "Edit Custom Server" })).toBeTruthy();
		expect(screen.queryByText(/^ID:/)).toBeNull();
		expect((screen.getByLabelText(/^Authentication Token/) as HTMLInputElement).value).toBe("old-0000");
		expect(screen.getByText("X-Team:")).toBeTruthy();
		await userEvent.clear(screen.getByLabelText("Name"));
		await typeName("Remote two");
		await userEvent.click(save("Save"));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "remote",
				name: "Remote two",
				headers: { Authorization: "Bearer old-0000", "X-Team": "core" },
			}),
		);
	});

	it("replaces the token with a new one and drops it when the field is emptied", async () => {
		show(REMOTE);
		const token = screen.getByLabelText(/^Authentication Token/);
		await userEvent.clear(token);
		await userEvent.type(token, "new-0000");
		await userEvent.click(save("Save"));
		expect(onSave.mock.calls[0][0].headers).toEqual({
			"X-Team": "core",
			Authorization: "Bearer new-0000",
		});

		await userEvent.clear(token);
		await userEvent.click(save("Save"));
		// Emptying the field used to keep the old token.
		expect(onSave.mock.calls[1][0].headers).toEqual({ "X-Team": "core" });
	});

	it("keeps an Authorization header that is not a bearer token", async () => {
		show({ ...REMOTE, headers: { authorization: "Basic dXNlcjpwYXNz" } });
		expect((screen.getByLabelText(/^Authentication Token/) as HTMLInputElement).value).toBe("");
		expect(screen.queryByPlaceholderText("Header Name")).toBeNull();
		await userEvent.click(save("Save"));
		expect(onSave.mock.calls[0][0].headers).toEqual({ authorization: "Basic dXNlcjpwYXNz" });
	});

	it("saves an HTTP server that had no headers with a first token", async () => {
		show({ id: "open", name: "Open", type: "http", url: "https://open.example/mcp" });
		await userEvent.type(screen.getByLabelText(/^Authentication Token/), "tok-0000");
		await userEvent.click(save("Save"));
		expect(onSave.mock.calls[0][0].headers).toEqual({ Authorization: "Bearer tok-0000" });
	});

	it("keeps a command server's arguments and the environment the catalog set", async () => {
		show({
			id: "docs",
			name: "Docs",
			type: "command",
			command: "npx",
			args: ["-y", "docs-mcp"],
			env: { DOCS_ROOT: "/srv/docs" },
		});
		expect((screen.getByLabelText("Arguments") as HTMLInputElement).value).toBe("-y docs-mcp");
		await userEvent.click(save("Save"));
		expect(onSave).toHaveBeenCalledWith({
			id: "docs",
			name: "Docs",
			type: "command",
			description: undefined,
			command: "npx",
			args: ["-y", "docs-mcp"],
			env: { DOCS_ROOT: "/srv/docs" },
		});
	});

	it("starts from an empty form when reopened to add a server", async () => {
		const view = show({ id: "bare", name: "Bare", type: "command" });
		expect((screen.getByLabelText("Command") as HTMLInputElement).value).toBe("");
		expect((screen.getByLabelText("Arguments") as HTMLInputElement).value).toBe("");
		view.reopen(null);
		const dialog = await screen.findByRole("dialog");
		expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("");
		expect((within(dialog).getByLabelText("Command") as HTMLInputElement).value).toBe("npx");
		expect(within(dialog).getByRole("heading", { name: "Add Custom Server" })).toBeTruthy();
	});
});
