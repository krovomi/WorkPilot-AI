import { describe, expect, it } from "vitest";
import { FRAMEWORKS_BY_TYPE } from "./architecture-blocks";
import { protocolsFor } from "./connection-protocols";

const postgres = { type: "database", framework: "Postgres" };

describe("protocolsFor", () => {
	it("names the usual data-access library of every stack that owns data", () => {
		// Every stack offered on a block that reads a database gets its own
		// library, not the generic "ORM" placeholder (Leub, 2026-11-07: cover
		// every language, never only Python / TypeScript).
		for (const type of ["backend", "microservice", "desktop", "mobile", "worker"]) {
			for (const framework of FRAMEWORKS_BY_TYPE[type]) {
				if (type === "worker" && framework === "Temporal") continue;
				const kind = type === "mobile" ? "localData" : "data";
				const options = protocolsFor(kind, { type, framework }, postgres, "en");
				expect(options[0], `${type} ${framework}`).not.toBe("ORM");
			}
		}
	});

	it("picks the library of the stack against a SQL database", () => {
		const first = (framework: string) =>
			protocolsFor("data", { type: "backend", framework }, postgres, "en")[0];
		expect(first("DotNet")).toBe("EF Core");
		expect(first("Spring")).toBe("JPA / Hibernate");
		expect(first("Django")).toBe("Django ORM");
		expect(first("NodeJs")).toBe("Prisma");
		expect(first("Go")).toBe("database/sql");
		expect(first("Rust")).toBe("SQLx");
		expect(first("Laravel")).toBe("Eloquent");
		expect(first("Symfony")).toBe("Doctrine");
		expect(first("Rails")).toBe("Active Record");
	});

	it("follows the database: MongoDB and Redis are not SQL", () => {
		const mongo = protocolsFor(
			"data",
			{ type: "backend", framework: "DotNet" },
			{ type: "database", framework: "MongoDb" },
			"en",
		);
		expect(mongo).toEqual(["MongoDB .NET Driver"]);
		const redis = protocolsFor(
			"data",
			{ type: "backend", framework: "NodeJs" },
			{ type: "database", framework: "Redis" },
			"en",
		);
		expect(redis).toEqual(["RESP (Redis)", "ioredis"]);
	});

	it("recognises what people type on a block without a stack list", () => {
		for (const typed of [".NET", "ASP.NET Core", "dotnet", "C#"]) {
			expect(
				protocolsFor("data", { type: "backend", framework: typed }, postgres, "en")[0],
				typed,
			).toBe("EF Core");
		}
	});

	it("uses the broker's own protocol and the stack's messaging library", () => {
		const kafka = { type: "messagebroker", framework: "Kafka" };
		expect(
			protocolsFor("publish", { type: "backend", framework: "Spring" }, kafka, "fr"),
		).toEqual(["Protocole Kafka", "Spring Kafka", "Spring Cloud Stream", "Outbox transactionnel"]);
		expect(
			protocolsFor(
				"consume",
				{ type: "queue", framework: "RabbitMq" },
				{ type: "worker", framework: "Celery" },
				"en",
			),
		).toEqual(["AMQP 0-9-1", "Celery"]);
	});

	it("pushes with the real-time stack of the server and the platform of the client", () => {
		expect(
			protocolsFor("push", { type: "backend", framework: "DotNet" }, { type: "frontend" }, "en")[0],
		).toBe("SignalR");
		expect(
			protocolsFor("push", { type: "backend", framework: "Rails" }, { type: "frontend" }, "en")[0],
		).toBe("Action Cable");
		expect(
			protocolsFor("push", { type: "notification" }, { type: "mobile", framework: "Flutter" }, "en")[0],
		).toBe("FCM / APNs");
	});

	it("only offers tRPC between TypeScript and Node", () => {
		const react = { type: "frontend", framework: "React" };
		expect(
			protocolsFor("api", react, { type: "backend", framework: "NodeJs" }, "en"),
		).toContain("tRPC");
		expect(
			protocolsFor("api", react, { type: "backend", framework: "Go" }, "en"),
		).not.toContain("tRPC");
	});

	it("speaks French where French says it differently", () => {
		expect(
			protocolsFor("job", { type: "backend" }, { type: "worker" }, "fr"),
		).toContain("File de messages");
		expect(
			protocolsFor("job", { type: "backend" }, { type: "worker" }, "en"),
		).toContain("Message queue");
	});
});
