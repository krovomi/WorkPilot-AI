import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { annotationPath, detectSpring } from "./jvm";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-jvm-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

const routesOf = (project: string) =>
	detectSpring(project)
		.map((route) => `${route.methods[0]} ${route.path}`)
		.sort();

describe("annotationPath", () => {
	it("reads every form Spring accepts", () => {
		expect(annotationPath('"/users"')).toBe("/users");
		expect(annotationPath('path = "/users"')).toBe("/users");
		expect(annotationPath('value = "/users"')).toBe("/users");
		expect(annotationPath('value = {"/users", "/people"}')).toBe("/users");
		expect(annotationPath("")).toBe("");
		expect(
			annotationPath("produces = MediaType.APPLICATION_JSON_VALUE"),
		).toBe("");
	});
});

describe("detectSpring", () => {
	it("composes the class mapping with each method mapping", () => {
		const project = createProject({
			"UserController.java": `package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api/users")
public class UserController {

    @GetMapping
    public List<User> findAll() { return null; }

    @GetMapping("/{id}")
    public User findOne(@PathVariable Long id) { return null; }

    @PostMapping(value = "/", produces = MediaType.APPLICATION_JSON_VALUE)
    public User create(@RequestBody User user) { return null; }

    @PreAuthorize("hasRole('ADMIN')")
    @DeleteMapping("/{id}")
    public void remove(@PathVariable Long id) {}
}`,
		});

		expect(routesOf(project)).toEqual([
			"DELETE /api/users/{id}",
			"GET /api/users",
			"GET /api/users/{id}",
			"POST /api/users",
		]);
		expect(
			detectSpring(project).find((r) => r.methods[0] === "DELETE")
				?.requiresAuth,
		).toBe(true);
		expect(detectSpring(project).every((r) => r.tag === "User")).toBe(true);
	});

	it("keeps two controllers in one file apart", () => {
		const project = createProject({
			"Controllers.java": `@RestController
@RequestMapping("/orders")
class OrderController {
    @GetMapping("/{id}")
    Order one() { return null; }
}

@RestController
@RequestMapping("/invoices")
class InvoiceController {
    @GetMapping
    List<Invoice> all() { return null; }
}`,
		});

		expect(routesOf(project)).toEqual([
			"GET /invoices",
			"GET /orders/{id}",
		]);
	});

	it("reads the verb of a bare @RequestMapping", () => {
		const project = createProject({
			"LegacyController.java": `@Controller
@RequestMapping("/legacy")
class LegacyController {
    @RequestMapping(method = RequestMethod.POST, path = "/submit")
    void submit() {}
}`,
		});

		expect(routesOf(project)).toEqual(["POST /legacy/submit"]);
	});

	it("ignores a class that is not a controller", () => {
		const project = createProject({
			"UserService.java": `@Service
class UserService {
    @GetMapping("/nope")
    void notARoute() {}
}`,
		});

		expect(routesOf(project)).toEqual([]);
	});
});
