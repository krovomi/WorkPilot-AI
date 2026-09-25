import { describe, expect, it } from "vitest";
import {
	buildChangeGraph,
	type ChangeGraphTranslate,
	type ChangeNode,
	describeEdge,
	describeGraph,
	describeNode,
	layerOf,
	roleOf,
	toGraphifyNodeLink,
} from "../change-graph";
import frTasks from "../../i18n/locales/fr/tasks.json";
import enTasks from "../../i18n/locales/en/tasks.json";

/** Un patch de fichier créé : chaque ligne est ajoutée. */
function added(...lines: string[]): string {
	return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function lookup(bundle: Record<string, unknown>, path: string[]): unknown {
	let value: unknown = bundle;
	for (const part of path) value = (value as Record<string, unknown>)?.[part];
	return value;
}

/** Un `t` minimal qui lit les vraies traductions, pour tester les phrases. */
function translator(bundle: Record<string, unknown>): ChangeGraphTranslate {
	return (key, options = {}) => {
		const path = key.replace(/^tasks:/, "").split(".");
		let value = lookup(bundle, path);
		if (typeof value !== "string" && typeof options.count === "number") {
			const last = path[path.length - 1];
			const form = options.count === 1 ? "one" : "other";
			value = lookup(bundle, [...path.slice(0, -1), `${last}_${form}`]);
		}
		if (typeof value !== "string") throw new Error(`missing key ${key}`);
		return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
			String(options[name] ?? ""),
		);
	};
}

const fr = translator(frTasks as Record<string, unknown>);
const en = translator(enTasks as Record<string, unknown>);

/** La tâche que l'utilisateur a décrite : une date de naissance, du Domain à l'API. */
const birthDateTask = [
	{
		path: "src/App.Domain/Entities/UserProfile.cs",
		status: "modified" as const,
		additions: 1,
		deletions: 0,
		patch: [
			"@@ -5,6 +5,7 @@ public class UserProfile",
			" {",
			"     public Guid Id { get; private set; }",
			"     public string Name { get; private set; }",
			"+    public DateOnly BirthDate { get; private set; }",
			" }",
		].join("\n"),
	},
	{
		path: "src/App.Application/Users/UserProfileDto.cs",
		status: "modified" as const,
		additions: 2,
		deletions: 1,
		patch: [
			"@@ -1,3 +1,4 @@",
			" namespace App.Application.Users;",
			"-public record UserProfileDto(Guid Id, string Name);",
			"+public record UserProfileDto(Guid Id, string Name, DateOnly BirthDate)",
			"+    { public static UserProfileDto From(UserProfile p) => new(p.Id, p.Name, p.BirthDate); }",
		].join("\n"),
	},
	{
		path: "src/App.Api/Controllers/UsersController.cs",
		status: "modified" as const,
		additions: 1,
		deletions: 1,
		patch: [
			"@@ -20,7 +20,7 @@ public class UsersController : ControllerBase",
			"     public async Task<ActionResult<UserProfileDto>> Get(Guid id)",
			"     {",
			"-        return Ok(await _service.Find(id));",
			"+        return Ok(UserProfileDto.From(await _service.Find(id)));",
			"     }",
		].join("\n"),
	},
	{
		path: "tests/App.Domain.Tests/UserProfileTests.cs",
		status: "added" as const,
		additions: 4,
		deletions: 0,
		patch: added(
			"public class UserProfileTests",
			"{",
			"    [Fact] public void Keeps_birth_date() { var p = new UserProfile(); }",
			"}",
		),
	},
	{
		path: "pnpm-lock.yaml",
		status: "modified" as const,
		additions: 400,
		deletions: 12,
		patch: "@@ -1 +1 @@\n-a\n+b",
	},
];

function byName(nodes: ChangeNode[], name: string): ChangeNode {
	const node = nodes.find((n) => n.name === name);
	if (!node) throw new Error(`no node ${name} in ${nodes.map((n) => n.name)}`);
	return node;
}

describe("layerOf", () => {
	it("lit les projets d'une solution clean architecture", () => {
		expect(layerOf("src/App.Domain/Entities/UserProfile.cs")).toBe("domain");
		expect(layerOf("src/App.Application/Users/UserDto.cs")).toBe("application");
		expect(layerOf("src/App.Infrastructure/Persistence/Db.cs")).toBe("infrastructure");
		expect(layerOf("src/App.Api/Controllers/UsersController.cs")).toBe("presentation");
	});

	it("range un test avec les tests, même sous un dossier Domain", () => {
		expect(layerOf("tests/App.Domain.Tests/UserProfileTests.cs")).toBe("tests");
		expect(layerOf("src/components/Card.test.tsx")).toBe("tests");
	});

	it("ne prend pas Contest.cs pour un test", () => {
		expect(layerOf("src/App.Domain/Contest.cs")).toBe("domain");
	});

	it("reconnaît la configuration et la documentation", () => {
		expect(layerOf("appsettings.json")).toBe("config");
		expect(layerOf("docs/README.md")).toBe("docs");
	});
});

describe("roleOf", () => {
	it("lit le rôle dans le suffixe du nom", () => {
		expect(roleOf("UserProfileDto", "x.cs")).toBe("dto");
		expect(roleOf("UsersController", "x.cs")).toBe("controller");
		expect(roleOf("CreateUserCommandHandler", "x.cs")).toBe("handler");
		expect(roleOf("UserProfile", "x.cs")).toBeUndefined();
	});
});

describe("buildChangeGraph — le chemin d'une propriété", () => {
	const graph = buildChangeGraph(birthDateTask, [
		{
			id: "subtask-1-1",
			title: "Ajouter la date de naissance au profil",
			files: ["App.Domain/Entities/UserProfile.cs"],
		},
	]);

	it("écarte les lockfiles", () => {
		expect(graph.skippedFiles).toEqual(["pnpm-lock.yaml"]);
	});

	it("voit la propriété ajoutée à l'entité", () => {
		const entity = byName(graph.nodes, "UserProfile");
		expect(entity.layer).toBe("domain");
		expect(entity.status).toBe("modified");
		expect(entity.members).toEqual([
			{ name: "BirthDate", kind: "property", change: "added" },
		]);
		expect(entity.subtaskIds).toEqual(["subtask-1-1"]);
	});

	it("lit un paramètre de record ajouté comme une propriété, et laisse les autres", () => {
		const dto = byName(graph.nodes, "UserProfileDto");
		expect(dto.role).toBe("dto");
		expect(dto.members).toContainEqual({
			name: "BirthDate",
			kind: "property",
			change: "added",
		});
		expect(dto.members.find((m) => m.name === "Id")).toBeUndefined();
	});

	it("relie le DTO à l'entité, avec la propriété qui suit le même chemin", () => {
		const edge = graph.edges.find(
			(e) =>
				e.source === byName(graph.nodes, "UserProfileDto").id &&
				e.target === byName(graph.nodes, "UserProfile").id,
		);
		expect(edge?.relation).toBe("maps");
		expect(edge?.sharedMembers).toEqual(["BirthDate"]);
	});

	it("attribue le corps modifié à la méthode du contrôleur", () => {
		const controller = byName(graph.nodes, "UsersController");
		expect(controller.members).toEqual([
			{ name: "Get", kind: "method", change: "modified" },
		]);
		expect(
			graph.edges.some(
				(e) =>
					e.source === controller.id &&
					e.target === byName(graph.nodes, "UserProfileDto").id,
			),
		).toBe(true);
	});

	it("marque le test comme test de l'entité", () => {
		const test = byName(graph.nodes, "UserProfileTests");
		expect(test.status).toBe("added");
		const edge = graph.edges.find((e) => e.source === test.id);
		expect(edge?.relation).toBe("tests");
	});

	it("ordonne les couches du cœur vers l'extérieur", () => {
		expect(graph.layers).toEqual(["domain", "application", "presentation", "tests"]);
	});
});

describe("les phrases", () => {
	const graph = buildChangeGraph(birthDateTask);
	const nodes = new Map(graph.nodes.map((n) => [n.id, n]));

	it("raconte l'entité comme l'agent le dirait", () => {
		expect(describeNode(byName(graph.nodes, "UserProfile"), fr)).toBe(
			"J'ai modifié la classe UserProfile dans la couche Domain et j'y ai ajouté la propriété BirthDate.",
		);
		expect(describeNode(byName(graph.nodes, "UserProfile"), en)).toBe(
			"I modified the class UserProfile in the Domain layer and added the property BirthDate to it.",
		);
	});

	it("dit que le DTO fait passer la donnée à la couche Application", () => {
		const dto = byName(graph.nodes, "UserProfileDto");
		const edge = graph.edges.find((e) => e.source === dto.id && e.relation === "maps");
		if (!edge) throw new Error("no maps edge from the DTO");
		const text = describeEdge(edge, nodes, fr);
		expect(text).toContain("Le DTO UserProfileDto");
		expect(text).toContain("de la classe UserProfile");
		expect(text).toContain("couche Application");
		expect(text).toContain("BirthDate");
	});

	it("rend un récit dans l'ordre des couches", () => {
		const story = describeGraph(graph, fr);
		expect(story[0]?.text).toMatch(/^J'ai modifié la classe UserProfile/);
		expect(story.every((entry) => entry.text.endsWith("."))).toBe(true);
	});
});

describe("autres langages", () => {
	it("TypeScript : un composant créé et une interface modifiée", () => {
		const graph = buildChangeGraph([
			{
				path: "src/renderer/components/ProfileCard.tsx",
				status: "added",
				patch: added(
					"export function ProfileCard({ profile }: { profile: UserProfile }) {",
					"  return <div>{profile.birthDate}</div>;",
					"}",
				),
			},
			{
				path: "src/shared/types/user.ts",
				status: "modified",
				patch: [
					"@@ -1,4 +1,5 @@",
					" export interface UserProfile {",
					"   name: string;",
					"+  birthDate?: string;",
					" }",
				].join("\n"),
			},
		]);
		const card = byName(graph.nodes, "ProfileCard");
		expect(card.kind).toBe("component");
		expect(card.status).toBe("added");
		const type = byName(graph.nodes, "UserProfile");
		expect(type.members).toEqual([
			{ name: "birthDate", kind: "property", change: "added" },
		]);
		expect(graph.edges.some((e) => e.source === card.id && e.target === type.id)).toBe(
			true,
		);
	});

	it("Python : une méthode ajoutée à une classe existante", () => {
		const graph = buildChangeGraph([
			{
				path: "app/services/user_service.py",
				patch: [
					"@@ -10,4 +10,7 @@ class UserService:",
					"     def find(self, id):",
					"         return self.repo.get(id)",
					"+",
					"+    def age(self, user):",
					"+        return 42",
				].join("\n"),
			},
		]);
		const service = byName(graph.nodes, "UserService");
		expect(service.members).toContainEqual({
			name: "age",
			kind: "method",
			change: "added",
		});
	});

	it("un fichier sans type devient un nœud fichier", () => {
		const graph = buildChangeGraph([
			{ path: "appsettings.json", patch: '@@ -1 +1 @@\n-{}\n+{"a":1}' },
		]);
		expect(graph.nodes).toHaveLength(1);
		expect(graph.nodes[0]?.kind).toBe("file");
		expect(graph.nodes[0]?.layer).toBe("config");
		const [config] = graph.nodes;
		if (!config) throw new Error("no node");
		expect(describeNode(config, fr)).toContain("appsettings.json");
	});
});

describe("plafond", () => {
	it("garde les nœuds les plus chargés et compte le reste", () => {
		const files = Array.from({ length: 10 }, (_, i) => ({
			path: `docs/page-${i}.md`,
			additions: i,
			deletions: 0,
			patch: "@@ -1 +1 @@\n-a\n+b",
		}));
		const graph = buildChangeGraph(files, [], { maxNodes: 3 });
		expect(graph.nodes).toHaveLength(3);
		expect(graph.truncatedFiles).toHaveLength(7);
	});
});

describe("toGraphifyNodeLink", () => {
	it("écrit le format node-link de Graphify", () => {
		const graph = buildChangeGraph(birthDateTask);
		const doc = toGraphifyNodeLink(graph, { taskId: "t1", describe: fr }) as {
			directed: boolean;
			nodes: Array<Record<string, unknown>>;
			links: Array<Record<string, unknown>>;
		};
		expect(doc.directed).toBe(true);
		const node = doc.nodes[0];
		expect(node).toHaveProperty("id");
		expect(node).toHaveProperty("label");
		expect(node).toHaveProperty("file_type", "code");
		expect(node).toHaveProperty("source_file");
		expect((node?.metadata as Record<string, unknown> | undefined)?.origin).toBe(
			"workpilot-change-graph",
		);
		expect(doc.links[0]).toHaveProperty("relation");
		expect(typeof doc.links[0]?.summary).toBe("string");
	});
});

describe("CQRS et abstractions", () => {
	const graph = buildChangeGraph([
		{
			path: "src/App.Application/Abstractions/IUserRepository.cs",
			patch: [
				"@@ -1,4 +1,5 @@ public interface IUserRepository",
				" {",
				"     Task<UserProfile> Get(Guid id);",
				"+    Task Save(UserProfile user);",
				" }",
			].join("\n"),
		},
		{
			path: "src/App.Infrastructure/Persistence/UserRepository.cs",
			patch: [
				"@@ -10,4 +10,6 @@ public class UserRepository : IUserRepository",
				"     public Task<UserProfile> Get(Guid id) => _db.Users.FindAsync(id).AsTask();",
				"+    public async Task Save(UserProfile user)",
				"+    { _db.Update(user); await _db.SaveChangesAsync(); }",
			].join("\n"),
		},
		{
			path: "src/App.Application/Users/UpdateBirthDateCommand.cs",
			status: "added",
			patch: added("public record UpdateBirthDateCommand(Guid Id, DateOnly BirthDate);"),
		},
		{
			path: "src/App.Application/Users/UpdateBirthDateCommandHandler.cs",
			status: "added",
			patch: added(
				"public class UpdateBirthDateCommandHandler",
				"{",
				"    public async Task Handle(UpdateBirthDateCommand cmd)",
				"    {",
				"        var user = await _repo.Get(cmd.Id);",
				"    }",
				"}",
			),
		},
	]);
	const nodes = new Map(graph.nodes.map((n) => [n.id, n]));

	it("lit un membre d'interface C#, sans modificateur", () => {
		const repository = byName(graph.nodes, "IUserRepository");
		expect(repository.members).toEqual([
			{ name: "Save", kind: "method", change: "added" },
		]);
		expect(describeNode(repository, fr)).toBe(
			"J'ai modifié l'interface IUserRepository dans la couche Application et j'y ai ajouté la méthode Save().",
		);
	});

	it("voit l'implémentation dans l'Infrastructure", () => {
		const impl = byName(graph.nodes, "UserRepository");
		const edge = graph.edges.find(
			(e) => e.source === impl.id && e.target === byName(graph.nodes, "IUserRepository").id,
		);
		expect(edge?.relation).toBe("implements");
		// Et pas l'inverse : une interface ne s'appuie pas sur son implémentation.
		expect(
			graph.edges.some(
				(e) =>
					e.source === byName(graph.nodes, "IUserRepository").id &&
					e.target === impl.id,
			),
		).toBe(false);
	});

	it("ne prend pas une variable locale `var` pour une propriété", () => {
		const handler = byName(graph.nodes, "UpdateBirthDateCommandHandler");
		expect(handler.members.map((m) => m.name)).toEqual(["Handle"]);
	});

	it("dit qu'un handler traite sa commande, et nomme les propriétés ensemble", () => {
		const handler = byName(graph.nodes, "UpdateBirthDateCommandHandler");
		const edge = graph.edges.find((e) => e.source === handler.id);
		expect(edge?.relation).toBe("handles");
		if (!edge) throw new Error("no edge");
		expect(describeEdge(edge, nodes, fr)).toBe(
			"Le handler UpdateBirthDateCommandHandler traite la commande UpdateBirthDateCommand.",
		);
		expect(describeNode(byName(graph.nodes, "UpdateBirthDateCommand"), fr)).toBe(
			"J'ai créé la commande UpdateBirthDateCommand dans la couche Application, avec les propriétés Id et BirthDate.",
		);
	});
});

describe("TypeScript — champs de classe et alias de type", () => {
	it("voit un champ ajouté sans modificateur, sans l'attribuer à la méthode d'avant", () => {
		const graph = buildChangeGraph([
			{
				path: "src/Counter.ts",
				patch: [
					"@@ -1,6 +1,8 @@ export class Counter {",
					"   reset() {",
					"     this.n = 0;",
					"   }",
					"+  count = 0;",
					"+  increment = () => {",
					"+    this.count = this.count + 1;",
					"+  };",
					" }",
				].join("\n"),
			},
		]);
		expect(byName(graph.nodes, "Counter").members).toEqual([
			{ name: "count", kind: "property", change: "added" },
			{ name: "increment", kind: "method", change: "added" },
		]);
	});

	it("ne prend pas une affectation dans le corps d'une méthode pour un champ", () => {
		const graph = buildChangeGraph([
			{
				path: "src/Counter.ts",
				patch: [
					"@@ -1,5 +1,6 @@ export class Counter {",
					"   reset() {",
					"     let total = 1;",
					"+    total = 2;",
					"   }",
				].join("\n"),
			},
		]);
		expect(byName(graph.nodes, "Counter").members).toEqual([
			{ name: "reset", kind: "method", change: "modified" },
		]);
	});

	it("appelle un alias de type un type, pas une interface", () => {
		const graph = buildChangeGraph([
			{
				path: "src/types.ts",
				status: "added",
				patch: added("export type Status = 'draft' | 'done';"),
			},
		]);
		const status = byName(graph.nodes, "Status");
		expect(status.kind).toBe("type");
		expect(describeNode(status, fr)).toBe(
			"J'ai créé le type Status dans le projet.",
		);
	});
});
