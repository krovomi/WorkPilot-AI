import { describe, expect, it } from "vitest";
import { type LintEdge, type LintNode, lintArchitecture } from "./architecture-lint";

const node = (id: string, type: string, framework?: string): LintNode => ({
	id,
	data: { type, label: id, framework },
});
const edge = (source: string, target: string, forced = false): LintEdge => ({
	id: `${source}-${target}`,
	source,
	target,
	data: forced ? { forced } : {},
});
const rules = (nodes: LintNode[], edges: LintEdge[]) =>
	lintArchitecture(nodes, edges, "fr").map((f) => f.rule);

describe("lintArchitecture", () => {
	it("finds nothing on a sound diagram", () => {
		const nodes = [
			node("Web", "frontend"),
			node("Gateway", "gateway"),
			node("API", "backend"),
			node("DB", "database"),
			node("Jobs", "queue"),
			node("Worker", "worker"),
		];
		const edges = [
			edge("Web", "Gateway"),
			edge("Gateway", "API"),
			edge("API", "DB"),
			edge("API", "Jobs"),
			edge("Jobs", "Worker"),
			edge("Worker", "DB"),
		];
		expect(lintArchitecture(nodes, edges, "fr")).toEqual([]);
	});

	it("wants one database per microservice", () => {
		const f = lintArchitecture(
			[node("Orders", "microservice"), node("Billing", "microservice"), node("DB", "database")],
			[edge("Orders", "DB"), edge("Billing", "DB")],
			"fr",
		);
		expect(f.map((x) => x.rule)).toEqual(["sharedDatabase"]);
		expect(f[0].message).toContain("« Orders », « Billing »");
		expect(f[0].nodeIds).toEqual(["DB", "Orders", "Billing"]);
	});

	it("reports a synchronous cycle between services once", () => {
		const nodes = [node("A", "microservice"), node("B", "microservice"), node("C", "backend")];
		const f = lintArchitecture(nodes, [edge("A", "B"), edge("B", "C"), edge("C", "A")], "en");
		expect(f.filter((x) => x.rule === "syncCycle")).toHaveLength(1);
		expect(f[0].message).toContain("“A” → “B” → “C” → “A”");
	});

	it("flags a client walking around the gateway", () => {
		expect(
			rules(
				[node("Web", "frontend"), node("GW", "gateway"), node("API", "backend")],
				[edge("Web", "GW"), edge("GW", "API"), edge("Web", "API")],
			),
		).toEqual(["gatewayBypass"]);
	});

	it("suggests a gateway to a client calling three services", () => {
		expect(
			rules(
				[node("App", "mobile"), node("A", "microservice"), node("B", "microservice"), node("C", "microservice")],
				[edge("App", "A"), edge("App", "B"), edge("App", "C")],
			),
		).toEqual(["clientManyServices"]);
	});

	it("wants every queue fed and read, and every store owned", () => {
		expect(
			rules([node("API", "backend"), node("Q", "queue")], [edge("API", "Q")]),
		).toEqual(["noConsumer"]);
		expect(
			rules([node("DB", "database"), node("S", "search")], [edge("DB", "S")]),
		).toEqual(["unownedStore"]);
	});

	it("flags a thick client that both writes the database and calls the backend", () => {
		expect(
			rules(
				[node("WPF", "desktop"), node("DB", "database"), node("API", "backend")],
				[edge("WPF", "DB"), edge("WPF", "API"), edge("API", "DB")],
			),
		).toEqual(["desktopBypass"]);
	});

	it("passes the stack mismatches and forced links on", () => {
		const f = lintArchitecture(
			[node("Bus", "messagebroker", "Kafka"), node("Jobs", "worker", "Celery"), node("Web", "frontend"), node("DB", "database")],
			[edge("Bus", "Jobs"), edge("Web", "DB", true)],
			"fr",
		);
		expect(f.map((x) => x.rule)).toEqual(
			expect.arrayContaining(["stack", "forced", "noProducer"]),
		);
		// Warnings come before information.
		expect(f.at(-1)?.severity).toBe("info");
	});

	it("notes a block linked to nothing", () => {
		expect(rules([node("A", "backend"), node("B", "cache")], [])).toEqual(["orphan", "orphan"]);
	});
});
