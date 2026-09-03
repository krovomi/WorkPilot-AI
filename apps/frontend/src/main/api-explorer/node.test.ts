import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectNode, toOpenApiPath } from "./node";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-node-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

const routesOf = (project: string) =>
	detectNode(project)
		.map((route) => `${route.methods[0]} ${route.path}`)
		.sort();

describe("toOpenApiPath", () => {
	it("rewrites the parameter syntax Express and Nest use", () => {
		expect(toOpenApiPath("/users/:id")).toBe("/users/{id}");
		expect(toOpenApiPath("/users/:userId/posts/:postId")).toBe(
			"/users/{userId}/posts/{postId}",
		);
		expect(toOpenApiPath("/files/*")).toBe("/files/{wildcard}");
		expect(toOpenApiPath("users/")).toBe("/users");
	});
});

describe("detectNode — NestJS", () => {
	it("prefixes the routes with the controller path", () => {
		const project = createProject({
			"src/users.controller.ts": `import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  @Get()
  findAll() {}

  @Get(':id')
  findOne(@Param('id') id: string) {}

  @UseGuards(AuthGuard)
  @Post()
  create() {}
}`,
		});

		expect(routesOf(project)).toEqual([
			"GET /users",
			"GET /users/{id}",
			"POST /users",
		]);
		expect(detectNode(project).every((r) => r.tag === "Users")).toBe(true);
		expect(
			detectNode(project).find((r) => r.methods[0] === "POST")?.requiresAuth,
		).toBe(true);
	});

	it("handles the object form and a controller without a prefix", () => {
		const project = createProject({
			"a.controller.ts": `@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  @Get(':id') findOne() {}
}`,
			"b.controller.ts": `@Controller()
export class RootController {
  @Get('health') health() {}
}`,
		});

		expect(routesOf(project)).toEqual(["GET /health", "GET /orders/{id}"]);
	});

	it("is not confused by braces inside a template literal", () => {
		const project = createProject({
			"c.controller.ts": `@Controller('reports')
export class ReportsController {
  private label = \`a } brace \${'in'} a template\`;

  @Get('daily')
  daily() {}
}`,
		});

		expect(routesOf(project)).toEqual(["GET /reports/daily"]);
	});
});

describe("detectNode — Express", () => {
	it("applies the prefix a router is mounted under, across files", () => {
		const project = createProject({
			"src/app.js": `const express = require('express');
const usersRouter = require('./routes/users');
const app = express();
app.use('/api/v1', usersRouter);
app.get('/health', (req, res) => res.send('ok'));`,
			"src/routes/users.js": `const express = require('express');
const router = express.Router();
router.get('/', (req, res) => {});
router.get('/:id', (req, res) => {});
router.post('/', (req, res) => {});
module.exports = router;`,
		});

		expect(routesOf(project)).toEqual([
			"GET /api/v1",
			"GET /api/v1/{id}",
			"GET /health",
			"POST /api/v1",
		]);
	});

	it("applies a prefix mounted in the same file", () => {
		const project = createProject({
			"server.ts": `const app = express();
const admin = Router();
admin.get('/stats', handler);
app.use('/admin', admin);`,
		});

		expect(routesOf(project)).toEqual(["GET /admin/stats"]);
	});

	it("does not mistake an HTTP client call for a route", () => {
		const project = createProject({
			"client.ts": `const app = express();
app.get('/ping', handler);
const data = await axios.get('https://example.com/things');`,
		});

		expect(routesOf(project)).toEqual(["GET /ping"]);
	});
});
