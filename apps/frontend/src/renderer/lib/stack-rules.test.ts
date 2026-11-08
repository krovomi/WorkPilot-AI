import { describe, expect, it } from "vitest";
import { stackWarnings } from "./stack-rules";

describe("stackWarnings", () => {
	it("knows which brokers a job runner can consume", () => {
		const celery = { type: "worker", framework: "Celery" };
		expect(stackWarnings({ type: "queue", framework: "Kafka" }, celery, "fr")).toHaveLength(1);
		expect(stackWarnings({ type: "queue", framework: "RabbitMq" }, celery, "fr")).toEqual([]);
		expect(
			stackWarnings({ type: "queue", framework: "RabbitMq" }, { type: "worker", framework: "BullMQ" }, "en")[0],
		).toMatch(/Redis/);
	});

	it("enqueues a job from its own language only", () => {
		const sidekiq = { type: "worker", framework: "Sidekiq" };
		expect(stackWarnings({ type: "backend", framework: "DotNet" }, sidekiq, "en")).toHaveLength(1);
		expect(stackWarnings({ type: "backend", framework: "Rails" }, sidekiq, "en")).toEqual([]);
		// A .NET worker can be fed from any stack (queue, gRPC, HTTP).
		expect(
			stackWarnings({ type: "backend", framework: "Go" }, { type: "worker", framework: "DotNet" }, "en"),
		).toEqual([]);
	});

	it("keeps a phone on SQLite and a server off it", () => {
		expect(
			stackWarnings({ type: "mobile", framework: "Flutter" }, { type: "database", framework: "Postgres" }, "fr")[0],
		).toMatch(/SQLite/);
		expect(
			stackWarnings({ type: "mobile" }, { type: "database", framework: "Sqlite" }, "fr"),
		).toEqual([]);
		expect(
			stackWarnings({ type: "microservice" }, { type: "database", framework: "Sqlite" }, "fr"),
		).toHaveLength(1);
	});

	it("never hands a search cluster's key to the browser", () => {
		expect(
			stackWarnings({ type: "frontend" }, { type: "search", framework: "Elasticsearch" }, "en"),
		).toHaveLength(1);
		expect(
			stackWarnings({ type: "frontend" }, { type: "search", framework: "Meilisearch" }, "en"),
		).toEqual([]);
	});

	it("does not push to an app through an email service", () => {
		expect(
			stackWarnings({ type: "notification", framework: "SendGrid" }, { type: "mobile" }, "fr"),
		).toHaveLength(1);
		expect(
			stackWarnings({ type: "notification", framework: "Firebase" }, { type: "mobile" }, "fr"),
		).toEqual([]);
	});

	it("names stacks the way the app shows them", () => {
		const [w] = stackWarnings(
			{ type: "queue", framework: "Sqs" },
			{ type: "worker", framework: "BullMQ" },
			"en",
			(k) => (k === "Sqs" ? "Amazon SQS" : k),
		);
		expect(w).toContain("Amazon SQS");
	});

	it("says nothing when no stack is picked", () => {
		expect(stackWarnings({ type: "queue" }, { type: "worker" }, "fr")).toEqual([]);
	});
});
