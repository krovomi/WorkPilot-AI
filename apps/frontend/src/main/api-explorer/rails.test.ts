import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRails, singularize, toOpenApiPath } from "./rails";
import type { DetectedRoute } from "./types";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-rails-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

function routesOf(body: string, extra: Record<string, string> = {}) {
	return detectRails(
		createProject({
			"config/routes.rb": `Rails.application.routes.draw do\n${body}\nend\n`,
			...extra,
		}),
	);
}

function summarise(routes: DetectedRoute[]): string[] {
	return routes
		.flatMap((route) => route.methods.map((method) => `${method} ${route.path}`))
		.sort();
}

const API_ONLY = {
	"config/application.rb": `module Rag
  class Application < Rails::Application
    config.api_only = true
  end
end`,
};

describe("helpers", () => {
	it.each([
		["posts", "post"],
		["categories", "category"],
		["boxes", "box"],
		["addresses", "address"],
		["profile", "profile"],
	])("singularizes %s", (input, expected) => {
		expect(singularize(input)).toBe(expected);
	});

	it.each([
		["/posts/:id", "/posts/{id}"],
		["/files/*path", "/files/{path}"],
		["posts", "/posts"],
		["/posts/(.:format)", "/posts"],
	])("normalises %s", (input, expected) => {
		expect(toOpenApiPath(input)).toBe(expected);
	});
});

describe("detectRails — nesting", () => {
	it("composes namespaces the route's own line never mentions", () => {
		const routes = routesOf(
			`  namespace :api do
    namespace :v1 do
      get 'health', to: 'health#show'
    end
  end`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual(["GET /api/v1/health"]);
	});

	it("reads a scope's path and ignores its module", () => {
		const routes = routesOf(
			`  scope '/admin', module: 'admin' do
    get 'stats', to: 'stats#index'
  end
  scope module: 'internal' do
    get 'ping', to: 'ping#show'
  end`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual(["GET /admin/stats", "GET /ping"]);
	});

	it("keeps the prefix through constraints and an environment guard", () => {
		const routes = routesOf(
			`  namespace :api do
    constraints subdomain: 'api' do
      get 'ping', to: 'ping#show'
    end
    if Rails.env.development?
      get 'debug', to: 'debug#index'
    end
  end`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual(["GET /api/debug", "GET /api/ping"]);
	});

	it("is not thrown by a modifier if, which takes no end", () => {
		const routes = routesOf(
			`  get 'ping', to: 'ping#show' if Rails.env.test?
  get 'health', to: 'health#show'`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual(["GET /health", "GET /ping"]);
	});
});

describe("detectRails — resources", () => {
	it("expands the seven actions of a plural resource", () => {
		expect(summarise(routesOf("  resources :posts"))).toEqual([
			"DELETE /posts/{id}",
			"GET /posts",
			"GET /posts/new",
			"GET /posts/{id}",
			"GET /posts/{id}/edit",
			"PATCH /posts/{id}",
			"POST /posts",
			"PUT /posts/{id}",
		]);
	});

	it("drops new and edit when the application is api_only", () => {
		expect(summarise(routesOf("  resources :posts", API_ONLY))).toEqual([
			"DELETE /posts/{id}",
			"GET /posts",
			"GET /posts/{id}",
			"PATCH /posts/{id}",
			"POST /posts",
			"PUT /posts/{id}",
		]);
	});

	it.each([
		["only: %i[index show]", ["GET /posts", "GET /posts/{id}"]],
		["only: [:index]", ["GET /posts"]],
		["only: :index", ["GET /posts"]],
		[
			"except: [:destroy, :update]",
			["GET /posts", "GET /posts/{id}", "POST /posts"],
		],
	])("honours %s", (options, expected) => {
		expect(summarise(routesOf(`  resources :posts, ${options}`, API_ONLY))).toEqual(
			expected,
		);
	});

	it("maps a singular resource without an id", () => {
		expect(
			summarise(routesOf("  resource :profile, only: [:show, :update]", API_ONLY)),
		).toEqual(["GET /profile", "PATCH /profile", "PUT /profile"]);
	});

	it("nests a child resource under the parent's foreign key", () => {
		const routes = routesOf(
			`  resources :posts, only: [:index] do
    resources :comments, only: [:index, :create]
  end`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual([
			"GET /posts",
			"GET /posts/{post_id}/comments",
			"POST /posts/{post_id}/comments",
		]);
	});

	it("reads member and collection blocks, do and brace alike", () => {
		const routes = routesOf(
			`  resources :documents, only: [] do
    member do
      get :preview
    end
    collection { get :search }
  end`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual([
			"GET /documents/search",
			"GET /documents/{id}/preview",
		]);
	});

	it("declares each resource of a shared line", () => {
		expect(
			summarise(routesOf("  resources :posts, :tags, only: [:index]", API_ONLY)),
		).toEqual(["GET /posts", "GET /tags"]);
	});

	it("honours a path override", () => {
		expect(
			summarise(
				routesOf("  resources :documents, path: 'docs', only: [:index]", API_ONLY),
			),
		).toEqual(["GET /docs"]);
	});
});

describe("detectRails — single routes", () => {
	it("reads root, the hash-rocket form and match via", () => {
		const routes = routesOf(
			`  root to: 'home#index'
  post '/reindex' => 'admin#reindex'
  match 'legacy', to: 'legacy#show', via: [:get, :post]`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual([
			"GET /",
			"GET /legacy",
			"POST /legacy",
			"POST /reindex",
		]);
	});

	it("tags a route by the controller it points at", () => {
		const [route] = routesOf("  get 'health', to: 'health#show'", API_ONLY);

		expect(route.tag).toBe("health");
		expect(route.summary).toBe("health#show");
	});

	it("leaves a mounted engine out of the application's own API", () => {
		const routes = routesOf(
			`  mount Sidekiq::Web => '/sidekiq'
  get 'health', to: 'health#show'`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual(["GET /health"]);
	});

	it("skips a commented-out route", () => {
		const routes = routesOf(
			`  # get 'old', to: 'old#show'
  get 'health', to: 'health#show'`,
			API_ONLY,
		);

		expect(summarise(routes)).toEqual(["GET /health"]);
	});
});
