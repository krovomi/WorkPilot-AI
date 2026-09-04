import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRust, toOpenApiPath } from "./rust";
import type { DetectedRoute } from "./types";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-rust-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

function summarise(routes: DetectedRoute[]): string[] {
	return routes
		.flatMap((route) => route.methods.map((method) => `${method} ${route.path}`))
		.sort();
}

describe("toOpenApiPath", () => {
	it.each([
		[":id", "/{id}"],
		["/users/:id", "/users/{id}"],
		["/users/{id}", "/users/{id}"],
		["/files/{*rest}", "/files/{rest}"],
		["/files/*rest", "/files/{rest}"],
		["/users/", "/users"],
		["/", "/"],
	])("normalises %s", (input, expected) => {
		expect(toOpenApiPath(input)).toBe(expected);
	});
});

describe("detectRust — Axum", () => {
	it("composes the prefix a nested router is mounted under", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let users = Router::new()
        .route("/", get(list_users))
        .route("/:id", get(show_user));

    let api = Router::new().nest("/users", users);

    let app = Router::new()
        .nest("/api/v1", api)
        .route("/health", get(health));

    axum::serve(listener, app).await.unwrap();
}`,
			}),
		);

		expect(summarise(routes)).toEqual([
			"GET /api/v1/users",
			"GET /api/v1/users/{id}",
			"GET /health",
		]);
	});

	it("keeps every verb of one MethodRouter", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `let app = Router::new()
    .route("/items", get(list).post(create))
    .route("/items/:id", get(show).put(update).delete(destroy));`,
			}),
		);

		expect(summarise(routes)).toEqual([
			"DELETE /items/{id}",
			"GET /items",
			"GET /items/{id}",
			"POST /items",
			"PUT /items/{id}",
		]);
	});

	it("follows .nest across the module that owns the routes", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `mod documents;

fn app() -> Router {
    Router::new().nest("/api", documents::routes())
}`,
				"src/documents.rs": `use axum::{routing::get, Router};

pub fn routes() -> Router {
    Router::new()
        .route("/documents", get(list))
        .route("/documents/:id", get(show))
}`,
			}),
		);

		expect(summarise(routes)).toEqual([
			"GET /api/documents",
			"GET /api/documents/{id}",
		]);
	});

	it("merges a router without adding a prefix", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `fn health() -> Router {
    Router::new().route("/health", get(ok))
}

fn app() -> Router {
    Router::new().nest("/api", inner()).merge(health())
}

fn inner() -> Router {
    Router::new().route("/things", get(list))
}`,
			}),
		);

		expect(summarise(routes)).toEqual(["GET /api/things", "GET /health"]);
	});

	it("reads MethodFilter and on()", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `let app = Router::new()
    .route("/webhook", on(MethodFilter::POST, receive));`,
			}),
		);

		expect(summarise(routes)).toEqual(["POST /webhook"]);
	});

	it("leaves a static file mount out of the API", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `let app = Router::new()
    .nest_service("/assets", ServeDir::new("assets"))
    .route("/health", get(ok));`,
			}),
		);

		expect(summarise(routes)).toEqual(["GET /health"]);
	});

	it("is not derailed by a lifetime in the same file", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `fn label(input: &'static str) -> &'static str { input }

fn app() -> Router {
    Router::new().route("/health", get(ok))
}`,
			}),
		);

		expect(summarise(routes)).toEqual(["GET /health"]);
	});

	it("reports a router built inline, with no binding to nest into", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `axum::serve(listener, Router::new().route("/ping", get(pong))).await?;`,
			}),
		);

		expect(summarise(routes)).toEqual(["GET /ping"]);
	});
});

describe("detectRust — Actix Web", () => {
	it("composes web::scope with the handler's own attribute path", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `use actix_web::{get, post, web, App, HttpServer, Responder};

#[get("/users/{id}")]
async fn show(id: web::Path<u32>) -> impl Responder { "" }

#[post("/users")]
async fn create() -> impl Responder { "" }

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new().service(
            web::scope("/api/v1")
                .service(show)
                .service(create),
        )
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}`,
			}),
		);

		expect(summarise(routes)).toEqual([
			"GET /api/v1/users/{id}",
			"POST /api/v1/users",
		]);
	});

	it("reads web::resource and its route chain", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `App::new().service(
    web::scope("/api")
        .service(
            web::resource("/things")
                .route(web::get().to(list))
                .route(web::post().to(create)),
        )
        .route("/health", web::get().to(ok)),
);`,
			}),
		);

		expect(summarise(routes)).toEqual([
			"GET /api/health",
			"GET /api/things",
			"POST /api/things",
		]);
	});

	it("follows .configure into the function that registers the services", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `pub fn documents(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/documents").route(web::get().to(list)));
}

fn main() {
    App::new().service(web::scope("/api").configure(documents));
}`,
			}),
		);

		expect(summarise(routes)).toEqual(["GET /api/documents"]);
	});

	it("nests one scope inside another", () => {
		const routes = detectRust(
			createProject({
				"src/main.rs": `App::new().service(
    web::scope("/api").service(
        web::scope("/v1").route("/ping", web::get().to(pong)),
    ),
);`,
			}),
		);

		expect(summarise(routes)).toEqual(["GET /api/v1/ping"]);
	});

	it("reports a handler no App in this file mounts", () => {
		const routes = detectRust(
			createProject({
				"src/handlers.rs": `use actix_web::{get, web, HttpResponse};

#[get("/status")]
async fn status() -> HttpResponse { HttpResponse::Ok().finish() }

pub fn init(cfg: &mut web::ServiceConfig) { cfg.service(status); }`,
			}),
		);

		expect(summarise(routes)).toEqual(["GET /status"]);
	});
});
