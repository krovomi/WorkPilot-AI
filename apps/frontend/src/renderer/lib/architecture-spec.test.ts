import { describe, expect, it } from "vitest";
import {
	buildArchitectureSpec,
	type DiagramEdgeInput,
	type DiagramNodeInput,
	sanitizeEdges,
} from "./architecture-spec";

const reactNode: DiagramNodeInput = {
	id: "1",
	data: { label: "React (Frontend)", type: "frontend", framework: "React" },
};
const dotnetNode: DiagramNodeInput = {
	id: "2",
	data: { label: "DotNet (Backend)", type: "backend", framework: "DotNet" },
};

describe("sanitizeEdges", () => {
	it("drops edges pointing at non-existent nodes (the edge-1-6 bug)", () => {
		const edges: DiagramEdgeInput[] = [
			{ source: "1", target: "6" }, // 6 doesn't exist
			{ source: "1", target: "2" },
		];
		const clean = sanitizeEdges([reactNode, dotnetNode], edges);
		expect(clean).toEqual([{ source: "1", target: "2" }]);
	});

	it("drops self-loops", () => {
		const clean = sanitizeEdges([reactNode], [{ source: "1", target: "1" }]);
		expect(clean).toHaveLength(0);
	});
});

describe("buildArchitectureSpec", () => {
	it("lists every component with its role and stack", () => {
		const { description } = buildArchitectureSpec(
			[reactNode, dotnetNode],
			[{ source: "1", target: "2" }],
			"flowchart",
		);
		expect(description).toContain("| React (Frontend) | Frontend UI | React |");
		expect(description).toContain("| DotNet (Backend) | Backend service | DotNet |");
	});

	it("requires a RESTful API + GET /health endpoint when a backend is present", () => {
		const { description, title } = buildArchitectureSpec(
			[reactNode, dotnetNode],
			[{ source: "1", target: "2" }],
		);
		expect(description).toContain("RESTful HTTP API");
		expect(description).toContain("GET /health");
		expect(description).toContain("200 OK");
		expect(description).toContain("Dockerfile");
		expect(title).toContain("Web API architecture");
		expect(title).toContain("React + DotNet");
	});

	it("wires frontend to backend when both are present", () => {
		const { description } = buildArchitectureSpec([reactNode, dotnetNode], []);
		expect(description).toContain("Wire the frontend to the backend API");
	});

	it("does not demand a health endpoint for a frontend-only mockup", () => {
		const { description, title } = buildArchitectureSpec(
			[reactNode],
			[],
			"mockup",
		);
		expect(description).not.toContain("GET /health");
		expect(description).toContain("runnable frontend app");
		expect(title).toContain("Frontend architecture");
	});

	it("ignores dangling edges in the connections section", () => {
		const { description } = buildArchitectureSpec(
			[reactNode, dotnetNode],
			[
				{ source: "1", target: "6" },
				{ source: "1", target: "2", data: { label: "calls" } },
			],
		);
		expect(description).toContain(
			"**React (Frontend)** → **DotNet (Backend)** (calls)",
		);
		expect(description).not.toContain("→ **Component 6**");
	});

	it("adds database + auth requirements when those blocks exist", () => {
		const db: DiagramNodeInput = {
			id: "3",
			data: { label: "Postgres", type: "database", framework: "Postgres" },
		};
		const auth: DiagramNodeInput = {
			id: "4",
			data: { label: "Auth", type: "auth", framework: "" },
		};
		const { description } = buildArchitectureSpec(
			[reactNode, dotnetNode, db, auth],
			[],
		);
		expect(description).toContain("database schema and migrations");
		expect(description).toContain("authentication component");
	});

	it("tailors requirements for a thick-client (desktop) architecture", () => {
		const desktop: DiagramNodeInput = {
			id: "1",
			data: { label: "EBP Client", type: "desktop", framework: "WPF" },
		};
		const db: DiagramNodeInput = {
			id: "2",
			data: { label: "SQL Server", type: "database", framework: "SqlServer" },
		};
		const { title, description } = buildArchitectureSpec(
			[desktop, db],
			[{ source: "1", target: "2", data: { label: "reads / writes" } }],
			"architecture",
		);
		expect(title).toContain("Desktop application architecture");
		expect(description).toContain("Desktop application"); // role
		expect(description).toContain("installer / MSI / setup"); // packaging req
		expect(description).not.toContain("GET /health"); // no web server needed
	});

	it("produces a French spec when lang is fr (ticket language)", () => {
		const { title, description } = buildArchitectureSpec(
			[reactNode, dotnetNode],
			[{ source: "1", target: "2", data: { label: "HTTP / REST" } }],
			"flowchart",
			"fr",
		);
		expect(title).toContain("Générer l'architecture Web API");
		expect(description).toContain("## Composants");
		expect(description).toContain("## Exigences");
		expect(description).toContain("| Composant | Rôle | Technologie |");
		expect(description).toContain("Service backend");
		expect(description).toContain("API HTTP RESTful");
		expect(description).toContain("GET /health");
		expect(description).toContain("Câbler le frontend à l'API backend");
		// English requirement text must NOT leak into a French ticket
		expect(description).not.toContain("production-ready, deployable** project");
	});
});

describe("buildArchitectureSpec — explanations and custom bricks", () => {
	const api: DiagramNodeInput = {
		id: "a",
		data: { label: "Orders API", type: "backend", framework: "DotNet" },
	};
	const db: DiagramNodeInput = {
		id: "d",
		data: { label: "Orders DB", type: "database", framework: "Postgres" },
	};
	const hermes: DiagramNodeInput = {
		id: "h",
		data: {
			label: "Hermes",
			type: "custom",
			kicker: "Agent principal",
			description: "Orchestre les sous-agents | par modèle",
		},
	};

	it("writes the automatic explanation under each connection", () => {
		const { description } = buildArchitectureSpec(
			[api, db],
			[{ source: "a", target: "d", data: { label: "reads / writes" } }],
			"architecture",
			"en",
		);
		expect(description).toContain(
			"- **Orders API** → **Orders DB** (reads / writes) — Orders API reads and writes its data in Orders DB",
		);
	});

	it("keeps the person's own sentence when they wrote one", () => {
		const { description } = buildArchitectureSpec(
			[api, hermes],
			[
				{
					source: "a",
					target: "h",
					data: { label: "MCP", description: "asks Hermes to summarise orders" },
				},
			],
			"architecture",
			"en",
		);
		expect(description).toContain("(MCP) — asks Hermes to summarise orders");
	});

	it("uses a brick's role and description, without breaking the table", () => {
		const { description } = buildArchitectureSpec([hermes], [], "architecture", "fr");
		expect(description).toContain(
			"| Hermes | Agent principal — Orchestre les sous-agents \\| par modèle | — |",
		);
	});

	it("asks for a runnable mobile app wired to the API", () => {
		const mobile: DiagramNodeInput = {
			id: "m",
			data: { label: "App", type: "mobile", framework: "Flutter" },
		};
		const { description } = buildArchitectureSpec(
			[mobile, api],
			[{ source: "m", target: "a" }],
			"architecture",
			"en",
		);
		expect(description).toContain("| App | Mobile application | Flutter |");
		expect(description).toContain("runnable project for the stated framework");
		expect(description).toContain("Wire the frontend to the backend API");
	});
});
