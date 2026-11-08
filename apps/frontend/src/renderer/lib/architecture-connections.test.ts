import { describe, expect, it } from "vitest";
import {
	canConnect,
	connectionLabel,
	explainConnection,
	knownPairs,
	relationOptions,
} from "./architecture-connections";
import { BLOCK_CATEGORIES } from "./architecture-blocks";

describe("canConnect", () => {
	it("allows logical software-architecture edges", () => {
		expect(canConnect("frontend", "backend")).toBe(true);
		expect(canConnect("backend", "database")).toBe(true);
		expect(canConnect("backend", "queue")).toBe(true);
		expect(canConnect("queue", "worker")).toBe(true);
		expect(canConnect("gateway", "microservice")).toBe(true);
	});

	it("lets a backend hand jobs to a worker, and a worker own its data", () => {
		// The pair of the bug report: BackEnd .NET → Worker .NET was refused.
		expect(canConnect("backend", "worker")).toBe(true);
		expect(canConnect("microservice", "worker")).toBe(true);
		expect(canConnect("worker", "database")).toBe(true);
		expect(canConnect("worker", "queue")).toBe(true);
		expect(canConnect("worker", "backend")).toBe(true);
		// …but a database does not call a worker.
		expect(canConnect("database", "worker")).toBe(false);
	});

	it("knows the server-push, webhook, CDC and replication edges", () => {
		expect(canConnect("backend", "frontend")).toBe(true);
		expect(canConnect("notification", "mobile")).toBe(true);
		expect(canConnect("thirdparty", "backend")).toBe(true);
		expect(canConnect("database", "search")).toBe(true);
		expect(canConnect("database", "database")).toBe(true);
		expect(canConnect("backend", "backend")).toBe(true);
		expect(canConnect("frontend", "frontend")).toBe(true);
	});

	it("lets every typed block report to monitoring", () => {
		for (const { type } of BLOCK_CATEGORIES.flatMap((c) => c.blocks)) {
			if (type === "monitoring") continue;
			expect(canConnect(type, "monitoring"), type).toBe(true);
		}
		expect(canConnect("monitoring", "monitoring")).toBe(false);
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

	it("follows the request direction (a database never calls its clients)", () => {
		expect(canConnect("frontend", "backend")).toBe(true);
		expect(canConnect("database", "backend")).toBe(false);
		expect(canConnect("cache", "backend")).toBe(false);
	});

	it("is permissive for untyped nodes and custom blocks", () => {
		expect(canConnect(undefined, "database")).toBe(true);
		expect(canConnect("worker", undefined)).toBe(true);
		expect(canConnect("custom", "database")).toBe(true);
		expect(canConnect("frontend", "custom")).toBe(true);
	});

	it("accepts only the self-edges that mean something", () => {
		expect(canConnect("microservice", "microservice")).toBe(true);
		expect(canConnect("custom", "custom")).toBe(true);
		expect(canConnect("cache", "cache")).toBe(true); // replication
		expect(canConnect("worker", "worker")).toBe(false);
		expect(canConnect("auth", "auth")).toBe(false);
	});

	it("only knows block types of the palette", () => {
		const types = new Set(
			BLOCK_CATEGORIES.flatMap((c) => c.blocks).map((b) => b.type),
		);
		for (const [src, tgt] of knownPairs()) {
			expect(types.has(src), src).toBe(true);
			expect(types.has(tgt), tgt).toBe(true);
		}
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

describe("explainConnection", () => {
	it("writes a sentence of its own for every known edge", () => {
		// A pair without one would fall back to the generic sentence and lose
		// what the relation means, both on the canvas and in the build spec.
		for (const [src, tgt] of knownPairs()) {
			for (const lang of ["en", "fr"] as const) {
				const sentence = explainConnection(src, tgt, "A", "B", lang);
				expect(sentence, `${src} → ${tgt}`).not.toBe(
					explainConnection("custom", undefined, "A", "B", lang),
				);
				expect(sentence).toContain("A");
				expect(sentence).toContain("B");
			}
		}
	});

	it("does not name a protocol the person may have changed", () => {
		expect(
			explainConnection("frontend", "backend", "Web", "API", "fr"),
		).toBe("Web appelle l'API exposée par API");
	});

	it("names both blocks, in the language of the app", () => {
		expect(
			explainConnection("backend", "database", "Orders API", "Orders DB", "en"),
		).toBe("Orders API reads and writes its data in Orders DB");
		expect(
			explainConnection("backend", "database", "Orders API", "Orders DB", "fr"),
		).toBe("Orders API lit et écrit ses données dans Orders DB");
	});

	it("puts the consumer first when the arrow points from the queue", () => {
		expect(
			explainConnection("queue", "worker", "Order events", "Fulfilment", "en"),
		).toMatch(/^Fulfilment consumes the messages waiting in Order events/);
	});

	it("falls back to a generic sentence for free and custom blocks", () => {
		expect(explainConnection("custom", undefined, "A", "B", "fr")).toBe(
			"A échange avec B",
		);
	});

	it("lets a mobile app call its backend like a web frontend", () => {
		expect(canConnect("mobile", "backend")).toBe(true);
		expect(connectionLabel("mobile", "gateway", "fr")).toBe("passe par");
	});

	it("lets a mobile app keep its data on the device", () => {
		expect(canConnect("mobile", "database")).toBe(true);
		expect(connectionLabel("mobile", "database", "fr")).toBe(
			"stocke en local dans",
		);
	});
});

describe("relationOptions", () => {
	const dotnet = (type: string) => ({ type, framework: "DotNet" });

	it("offers the .NET ways for a backend to hand work to a worker", () => {
		const options = relationOptions(dotnet("backend"), dotnet("worker"), "fr");
		expect(options[0]).toBe("déclenche");
		for (const p of ["MassTransit", "Hangfire", "gRPC", "HTTP / REST", "File de messages"]) {
			expect(options, p).toContain(p);
		}
	});

	it("starts with the canvas' own label, then the protocols", () => {
		const options = relationOptions(
			{ type: "frontend", framework: "React" },
			dotnet("backend"),
			"en",
		);
		expect(options[0]).toBe("HTTP / REST");
		expect(options).toEqual(expect.arrayContaining(["GraphQL", "gRPC-Web", "SignalR", "WebSocket"]));
		// A browser has no native gRPC.
		expect(options).not.toContain("gRPC");
	});

	it("has no duplicates", () => {
		for (const [src, tgt] of knownPairs()) {
			const options = relationOptions({ type: src }, { type: tgt }, "fr");
			expect(new Set(options).size, `${src} → ${tgt}`).toBe(options.length);
		}
	});

	it("offers something to pick for every pair of block types, even unforeseen ones", () => {
		const types = BLOCK_CATEGORIES.flatMap((c) => c.blocks).map((b) => b.type);
		for (const src of types) {
			for (const tgt of types) {
				const options = relationOptions({ type: src }, { type: tgt }, "en");
				expect(options.length, `${src} → ${tgt}`).toBeGreaterThan(1);
			}
		}
		expect(relationOptions({ type: "database" }, { type: "frontend" }, "fr")).toEqual(
			expect.arrayContaining(["relié à", "HTTP / REST", "gRPC"]),
		);
	});
});
