import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectPython, toOpenApiPath } from "./python";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-python-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

const routesOf = (project: string) =>
	detectPython(project)
		.map((route) => `${route.methods.join("|")} ${route.path}`)
		.sort();

describe("toOpenApiPath", () => {
	it("rewrites Flask and Django parameter syntax", () => {
		expect(toOpenApiPath("/users/<int:id>")).toBe("/users/{id}");
		expect(toOpenApiPath("users/<pk>/")).toBe("/users/{pk}");
		expect(toOpenApiPath("/")).toBe("/");
	});
});

describe("detectPython — FastAPI", () => {
	it("composes the router prefix with the include prefix, across files", () => {
		const project = createProject({
			"main.py": `from fastapi import FastAPI
from routers import items

app = FastAPI()
app.include_router(items.router, prefix="/api/v1")

@app.get("/health")
def health():
    return {"ok": True}`,
			"routers/items.py": `from fastapi import APIRouter, Depends

router = APIRouter(prefix="/items", tags=["items"])

@router.get("/")
def list_items():
    ...

@router.get("/{item_id}")
def get_item(item_id: int):
    ...

@router.post("/", dependencies=[Depends(auth)])
def create_item():
    ...`,
		});

		expect(routesOf(project)).toEqual([
			"GET /api/v1/items",
			"GET /api/v1/items/{item_id}",
			"GET /health",
			"POST /api/v1/items",
		]);
		expect(
			detectPython(project).find((r) => r.methods[0] === "POST")?.requiresAuth,
		).toBe(true);
	});

	it("applies a router included by name in the same file", () => {
		const project = createProject({
			"app.py": `from fastapi import FastAPI, APIRouter

router = APIRouter(prefix="/orders")
app = FastAPI()

@router.get("/{id}")
def one(): ...

app.include_router(router, prefix="/v2")`,
		});

		expect(routesOf(project)).toEqual(["GET /v2/orders/{id}"]);
	});
});

describe("detectPython — Flask", () => {
	it("carries the blueprint url_prefix and reads the methods", () => {
		const project = createProject({
			"views.py": `from flask import Blueprint

bp = Blueprint("users", __name__, url_prefix="/users")

@bp.route("/", methods=["GET", "POST"])
def index():
    ...

@bp.route("/<int:user_id>")
def show(user_id):
    ...`,
		});

		expect(routesOf(project)).toEqual([
			"GET /users/{user_id}",
			"GET|POST /users",
		]);
		expect(detectPython(project).every((r) => r.framework === "Flask")).toBe(
			true,
		);
	});

	it("adds the prefix a blueprint is registered under", () => {
		const project = createProject({
			"app.py": `from flask import Flask, Blueprint

bp = Blueprint("api", __name__, url_prefix="/things")

@bp.get("/<id>")
def show(id): ...

app = Flask(__name__)
app.register_blueprint(bp, url_prefix="/api")`,
		});

		expect(routesOf(project)).toEqual(["GET /api/things/{id}"]);
	});
});

describe("detectPython — Django", () => {
	it("reads urlpatterns", () => {
		const project = createProject({
			"urls.py": `from django.urls import path

urlpatterns = [
    path("users/", views.index),
    path("users/<int:pk>/", views.detail),
]`,
		});

		expect(routesOf(project)).toEqual(["GET /users", "GET /users/{pk}"]);
	});
});
