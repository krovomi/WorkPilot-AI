import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ServerClient } from "../api/client";
import { api } from "../api/endpoints";
import "../i18n";
import { featuresByPhase, readIdeas, readRoadmap } from "../features/files";
import { JobBar } from "../features/JobBar";

let mockPermissions: string[] = [];
jest.mock("../auth/session", () => ({ useSession: () => ({ can: (p: string) => mockPermissions.includes(p) }) }));

const roadmapJson = JSON.stringify({
	vision: "Ship faster",
	phases: [
		{ id: "phase-2", name: "Growth", description: "", order: 2 },
		{ id: "phase-1", name: "MVP", description: "First", order: 1 },
	],
	features: [
		{ id: "f1", title: "Login", description: "Sign in", priority: "must", phase_id: "phase-1", status: "idea" },
		{ id: "f2", title: "Export", phase_id: "phase-2", status: "planned", linked_spec_id: "003-export" },
		{ id: "f3", title: "Orphan", phase_id: "phase-9" },
		{ id: "", title: "No id" },
		"not an object",
	],
});

describe("roadmap and ideation files", () => {
	it("reads the roadmap, phases in order, unknown phases last", () => {
		const view = readRoadmap(roadmapJson);
		if (!view) throw new Error("roadmap not read");
		expect(view.vision).toBe("Ship faster");
		const groups = featuresByPhase(view);
		expect(groups.map((g) => g.phase?.name ?? null)).toEqual(["MVP", "Growth", null]);
		expect(groups[1].features[0].linkedCardId).toBe("003-export");
		expect(view.features.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
	});

	it("draws nothing from a broken file", () => {
		expect(readRoadmap("{not json")).toBeNull();
		expect(readRoadmap("[]")).toBeNull();
		expect(readRoadmap(undefined)).toBeNull();
		expect(readIdeas("{")).toEqual([]);
	});

	it("keeps ideas of the known types only", () => {
		const ideas = readIdeas(
			JSON.stringify({
				ideas: [
					{ id: "i1", type: "security_hardening", title: "Pin deps", severity: "high", linked_task_id: "004-pin" },
					{ id: "i2", type: "made_up", title: "Nope" },
					{ id: "i3", type: "code_quality", title: "Split module", estimated_effort: "small" },
				],
			}),
		);
		expect(ideas.map((i) => [i.id, i.level, i.linkedCardId])).toEqual([
			["i1", "high", "004-pin"],
			["i3", "small", null],
		]);
	});
});

describe("feature routes", () => {
	it("address the project by id and never by path", async () => {
		const calls: string[] = [];
		const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/auth/login")) {
				const user = { id: "u", email: "a@x", display_name: "A", role: "member" };
				return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 900, user }));
			}
			calls.push(`${init?.method} ${url} ${init?.body ?? ""}`);
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new ServerClient({ baseUrl: "https://wp.example.com", fetchImpl });
		await client.login("a@x", "pw");
		const routes = api(client);
		await routes.featureSnapshot("roadmap", "p 1");
		await routes.startFeatureJob("ideation", "p1", { append: true });
		await routes.featureJob("roadmap", "p1", "j1", 12);
		await routes.convertIdea("p1", "idea/../x");
		await routes.askInsight("p1", "s1", "Where is auth?");
		expect(calls).toEqual([
			"GET https://wp.example.com/api/features/roadmap/snapshot?project_id=p%201 ",
			'POST https://wp.example.com/api/features/ideation/jobs?project_id=p1 {"append":true}',
			"GET https://wp.example.com/api/features/roadmap/jobs/j1?project_id=p1&after=12 ",
			"POST https://wp.example.com/api/features/ideation/ideas/idea%2F..%2Fx/convert?project_id=p1 ",
			'POST https://wp.example.com/api/features/insights/sessions/s1/messages?project_id=p1 {"message":"Where is auth?"}',
		]);
	});
});

describe("JobBar", () => {
	const job = { id: "j", feature: "roadmap", started_by: null, started_at: null, finished_at: null, error: null };

	it("offers to generate only to who may run agents", async () => {
		mockPermissions = [];
		const onStart = jest.fn(async () => undefined);
		const view = await render(
			<JobBar job={null} active={false} lastLine={null} hasContent={false} onStart={onStart} onCancel={jest.fn()} />,
		);
		expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
		mockPermissions = ["agent.execute"];
		await view.rerender(
			<JobBar job={null} active={false} lastLine={null} hasContent={false} onStart={onStart} onCancel={jest.fn()} />,
		);
		await fireEvent.press(screen.getByRole("button", { name: "Generate" }));
		await waitFor(() => expect(onStart).toHaveBeenCalled());
	});

	it("shows the running job's last line and its failure", async () => {
		mockPermissions = ["agent.execute", "agent.cancel"];
		const view = await render(
			<JobBar
				job={{ ...job, status: "running" }}
				active
				lastLine="Analysing the project"
				hasContent
				onStart={jest.fn()}
				onCancel={jest.fn()}
			/>,
		);
		expect(screen.getByText("Analysing the project")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
		await view.rerender(
			<JobBar
				job={{ ...job, status: "failed", error: "no model" }}
				active={false}
				lastLine={null}
				hasContent
				onStart={jest.fn()}
				onCancel={jest.fn()}
			/>,
		);
		expect(screen.getByText(/The last run failed\. no model/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Generate again" })).toBeTruthy();
	});
});
