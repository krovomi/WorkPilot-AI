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
