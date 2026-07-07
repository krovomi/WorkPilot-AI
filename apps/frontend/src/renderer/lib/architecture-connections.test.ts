import { describe, expect, it } from "vitest";
import { canConnect, connectionLabel } from "./architecture-connections";

describe("canConnect", () => {
	it("allows logical software-architecture edges", () => {
		expect(canConnect("frontend", "backend")).toBe(true);
		expect(canConnect("backend", "database")).toBe(true);
		expect(canConnect("backend", "queue")).toBe(true);
		expect(canConnect("queue", "worker")).toBe(true);
		expect(canConnect("gateway", "microservice")).toBe(true);
	});

	it("rejects the Worker → Database shortcut (must go via queue/backend)", () => {
		expect(canConnect("worker", "database")).toBe(false);
		expect(canConnect("database", "worker")).toBe(false);
	});

	it("rejects nonsensical edges", () => {
		expect(canConnect("database", "frontend")).toBe(false);
		expect(canConnect("cache", "cdn")).toBe(false);
		expect(canConnect("frontend", "database")).toBe(false);
	});

	it("lets a thick client (desktop) reach the DB directly (2-tier) or a backend (3-tier)", () => {
		expect(canConnect("desktop", "database")).toBe(true);
		expect(canConnect("desktop", "backend")).toBe(true);
		expect(canConnect("desktop", "auth")).toBe(true);
		// but a *web* frontend still may not hit the DB directly
		expect(canConnect("frontend", "database")).toBe(false);
	});

	it("enforces direction (frontend → backend, not the reverse)", () => {
		expect(canConnect("frontend", "backend")).toBe(true);
		expect(canConnect("backend", "frontend")).toBe(false);
	});

	it("is permissive for untyped nodes and custom blocks", () => {
		expect(canConnect(undefined, "database")).toBe(true);
		expect(canConnect("worker", undefined)).toBe(true);
		expect(canConnect("custom", "database")).toBe(true);
		expect(canConnect("frontend", "custom")).toBe(true);
	});

	it("rejects self-edges except custom", () => {
		expect(canConnect("backend", "backend")).toBe(false);
		expect(canConnect("microservice", "microservice")).toBe(true);
		expect(canConnect("custom", "custom")).toBe(true);
	});
});

describe("connectionLabel", () => {
	it("returns the localized relationship label", () => {
		expect(connectionLabel("backend", "database", "en")).toBe("reads / writes");
		expect(connectionLabel("backend", "database", "fr")).toBe("lit / écrit");
		expect(connectionLabel("frontend", "backend", "fr")).toBe("HTTP / REST");
		expect(connectionLabel("backend", "queue", "fr")).toBe("publie dans");
	});

	it("falls back to a generic label for permissive connections", () => {
		expect(connectionLabel("custom", "database", "en")).toBe("connects to");
		expect(connectionLabel(undefined, "backend", "fr")).toBe("relié à");
	});
});
