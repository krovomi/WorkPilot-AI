import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	detectWsl,
	LINUX_OPENERS,
	LINUX_SCHEME_OPENERS,
	openExternalUrl,
	parseExternalUrl,
	readAutomountRoot,
	wslToWindowsPath,
} from "./open-external";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

/** Un faux processus d'ouvreur dont on choisit le verdict. */
function fakeOpener(outcome: "ok" | "missing" | "refused") {
	const child = new EventEmitter() as EventEmitter & { unref: () => void };
	child.unref = () => undefined;
	queueMicrotask(() => {
		if (outcome === "missing") child.emit("error", new Error("ENOENT"));
		else child.emit("exit", outcome === "ok" ? 0 : 3);
	});
	return child as never;
}

describe("parseExternalUrl", () => {
	it("distingue une URL illisible d'un schéma refusé", () => {
		expect(parseExternalUrl("https://example.com/x").host).toBe("example.com");
		expect(() => parseExternalUrl("pas une url")).toThrow(/Invalid URL format/);
		expect(() => parseExternalUrl("file:///etc/passwd")).toThrow(
			/Unsafe URL protocol: file:/,
		);
		expect(() => parseExternalUrl("javascript:alert(1)")).toThrow(
			/Unsafe URL protocol/,
		);
	});
});

describe("openExternalUrl", () => {
	it("s'arrête au premier succès, sans lancer de processus", async () => {
		const openExternal = vi.fn().mockResolvedValue(undefined);
		const spawnOpener = vi.fn();
		await openExternalUrl("http://localhost:5000/swagger", {
			openExternal,
			linux: true,
			spawnOpener,
		});
		expect(openExternal).toHaveBeenCalledWith("http://localhost:5000/swagger");
		expect(spawnOpener).not.toHaveBeenCalled();
	});

	it("remonte l'échec tel quel hors de Linux", async () => {
		const spawnOpener = vi.fn();
		await expect(
			openExternalUrl("https://example.com", {
				openExternal: vi.fn().mockRejectedValue(new Error("no handler")),
				linux: false,
				spawnOpener,
			}),
		).rejects.toThrow("no handler");
		expect(spawnOpener).not.toHaveBeenCalled();
	});

	it("essaie les ouvreurs Linux jusqu'à celui qui répond", async () => {
		const spawnOpener = vi
			.fn()
			.mockImplementationOnce(() => fakeOpener("missing"))
			.mockImplementationOnce(() => fakeOpener("refused"))
			.mockImplementationOnce(() => fakeOpener("ok"));
		await openExternalUrl("http://localhost:5000/", {
			openExternal: vi.fn().mockRejectedValue(new Error("portal unavailable")),
			linux: true,
			spawnOpener,
		});
		expect(spawnOpener).toHaveBeenCalledTimes(3);
		expect(spawnOpener).toHaveBeenNthCalledWith(1, "xdg-open", [
			"http://localhost:5000/",
		]);
		// `gio` porte un sous-commande, que l'URL suit.
		expect(spawnOpener).toHaveBeenNthCalledWith(2, "gio", [
			"open",
			"http://localhost:5000/",
		]);
	});

	it("nomme ce qui a été essayé quand rien n'ouvre", async () => {
		const spawnOpener = vi.fn(() => fakeOpener("missing"));
		await expect(
			openExternalUrl("http://localhost:5000/", {
				openExternal: vi.fn().mockRejectedValue(new Error("xdg-open missing")),
				linux: true,
				spawnOpener,
			}),
		).rejects.toThrow(/xdg-open missing[\s\S]*Tried: xdg-open, gio/);
		expect(spawnOpener).toHaveBeenCalledTimes(LINUX_OPENERS.length);
	});

	it("refuse le schéma avant d'essayer quoi que ce soit", async () => {
		const openExternal = vi.fn();
		await expect(
			openExternalUrl("file:///etc/passwd", {
				openExternal,
				linux: true,
				spawnOpener: vi.fn(),
			}),
		).rejects.toThrow(/Unsafe URL protocol/);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("survit à un spawn qui lève", async () => {
		const spawnOpener = vi.fn(() => {
			throw new Error("EACCES");
		});
		await expect(
			openExternalUrl("http://localhost:5000/", {
				openExternal: vi.fn().mockRejectedValue(new Error("nope")),
				linux: true,
				spawnOpener: spawnOpener as never,
			}),
		).rejects.toThrow(/Unable to open/);
	});
});

describe("wslToWindowsPath", () => {
	it("rend un fichier d'un disque Windows monté par sa lettre", () => {
		expect(
			wslToWindowsPath("/mnt/c/Users/leub/Vault/note.md", "/mnt/", "Ubuntu"),
		).toBe("C:\\Users\\leub\\Vault\\note.md");
		expect(wslToWindowsPath("/mnt/d", "/mnt/", "Ubuntu")).toBe("D:\\");
		expect(wslToWindowsPath("/win/e/x.md", "/win", undefined)).toBe("E:\\x.md");
	});

	it("rend un fichier du Linux par le partage wsl.localhost", () => {
		expect(
			wslToWindowsPath("/home/leub/.workpilot/knowledge/n.md", "/mnt/", "Ubuntu"),
		).toBe("\\\\wsl.localhost\\Ubuntu\\home\\leub\\.workpilot\\knowledge\\n.md");
		// /mnt/wsl n'est pas un disque : une lettre seule en est un
		expect(wslToWindowsPath("/mnt/wsl/x", "/mnt/", "Ubuntu")).toBe(
			"\\\\wsl.localhost\\Ubuntu\\mnt\\wsl\\x",
		);
	});

	it("ne devine pas une distribution inconnue", () => {
		expect(wslToWindowsPath("/home/leub/n.md", "/mnt/", undefined)).toBeNull();
	});
});

describe("readAutomountRoot / detectWsl", () => {
	it("lit [automount] root, sinon /mnt/", () => {
		expect(readAutomountRoot(() => "[automount]\nroot = /win\n")).toBe("/win/");
		expect(readAutomountRoot(() => "[network]\nroot=/nope\n")).toBe("/mnt/");
		expect(
			readAutomountRoot(() => {
				throw new Error("ENOENT");
			}),
		).toBe("/mnt/");
	});

	it("reconnaît WSL par l'environnement ou le noyau, jamais hors Linux", () => {
		const noFile = () => {
			throw new Error("ENOENT");
		};
		expect(detectWsl(true, { WSL_DISTRO_NAME: "Ubuntu" }, noFile)).toBe(true);
		expect(detectWsl(true, {}, () => "6.6.87.2-microsoft-standard-WSL2")).toBe(true);
		expect(detectWsl(true, {}, () => "6.8.0-generic")).toBe(false);
		expect(detectWsl(false, { WSL_DISTRO_NAME: "Ubuntu" }, noFile)).toBe(false);
	});
});

describe("openExternalUrl — obsidian:", () => {
	const uri = `obsidian://open?path=${encodeURIComponent("/home/leub/.workpilot/knowledge/projects/dotnet/memory/session 2.md")}`;

	it("sous WSL, confie le lien à Windows avec le chemin Windows", async () => {
		const openExternal = vi.fn();
		const spawnOpener = vi.fn(() => fakeOpener("ok"));
		await openExternalUrl(uri, {
			openExternal,
			linux: true,
			wsl: true,
			toWindowsPath: (p) => wslToWindowsPath(p, "/mnt/", "Ubuntu"),
			spawnOpener,
		});
		expect(openExternal).not.toHaveBeenCalled();
		expect(spawnOpener).toHaveBeenCalledTimes(1);
		const [command, args] = spawnOpener.mock.calls[0] as unknown as [string, string[]];
		expect(command).toBe("powershell.exe");
		const expected = `obsidian://open?path=${encodeURIComponent(
			"\\\\wsl.localhost\\Ubuntu\\home\\leub\\.workpilot\\knowledge\\projects\\dotnet\\memory\\session 2.md",
		)}`;
		expect(args[args.length - 1]).toBe(`Start-Process '${expected}'`);
		// les espaces restent %20 : Obsidian ne décode pas `+`
		expect(expected).toContain("session%202.md");
	});

	it("sous WSL, essaie PowerShell par son chemin quand le PATH Windows manque", async () => {
		const spawnOpener = vi
			.fn()
			.mockImplementationOnce(() => fakeOpener("missing"))
			.mockImplementationOnce(() => fakeOpener("ok"));
		await openExternalUrl(uri, {
			linux: true,
			wsl: true,
			toWindowsPath: () => "C:\\v\\n.md",
			spawnOpener,
		});
		expect(spawnOpener).toHaveBeenNthCalledWith(
			2,
			"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
			expect.any(Array),
		);
	});

	it("sous WSL, double les apostrophes du lien pour PowerShell", async () => {
		const spawnOpener = vi.fn(() => fakeOpener("ok"));
		await openExternalUrl(
			`obsidian://open?path=${encodeURIComponent("/mnt/c/v/l'idée.md")}`,
			{
				linux: true,
				wsl: true,
				toWindowsPath: (p) => wslToWindowsPath(p, "/mnt/", "Ubuntu"),
				spawnOpener,
			},
		);
		const [, args] = spawnOpener.mock.calls[0] as unknown as [string, string[]];
		expect(args[args.length - 1]).toContain("l''id");
	});

	it("sous WSL, lève avec une raison quand rien n'ouvre", async () => {
		await expect(
			openExternalUrl(uri, {
				linux: true,
				wsl: true,
				toWindowsPath: () => null,
				spawnOpener: vi.fn(),
			}),
		).rejects.toThrow(/no Windows path/);
		await expect(
			openExternalUrl(uri, {
				linux: true,
				wsl: true,
				toWindowsPath: () => "C:\\n.md",
				spawnOpener: vi.fn(() => fakeOpener("refused")),
			}),
		).rejects.toThrow(/in Obsidian from WSL/);
	});

	it("sur Linux, ne confie jamais le lien à un navigateur", async () => {
		const spawnOpener = vi.fn(() => fakeOpener("missing"));
		await expect(
			openExternalUrl(uri, {
				openExternal: vi.fn().mockRejectedValue(new Error("no handler")),
				linux: true,
				wsl: false,
				spawnOpener,
			}),
		).rejects.toThrow(/in Obsidian \(no handler\)/);
		expect(spawnOpener).toHaveBeenCalledTimes(LINUX_SCHEME_OPENERS.length);
		const tried = spawnOpener.mock.calls.map((c) => (c as unknown[])[0]);
		expect(tried).not.toContain("firefox");
	});

	it("hors WSL, passe le lien tel quel à shell.openExternal", async () => {
		const openExternal = vi.fn().mockResolvedValue(undefined);
		await openExternalUrl("obsidian://open?path=C%3A%5Cv%5Cn.md", {
			openExternal,
			linux: false,
			wsl: false,
			spawnOpener: vi.fn(),
		});
		expect(openExternal).toHaveBeenCalledWith("obsidian://open?path=C%3A%5Cv%5Cn.md");
	});
});
