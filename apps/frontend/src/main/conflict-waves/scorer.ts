/**
 * Conflict score of a pair of specs, from the files both of them touch.
 *
 * Language-agnostic on purpose: a file weighs by what it is for the whole
 * build (a dependency manifest or lockfile that every spec adding a package
 * rewrites, a shared configuration file), never by its programming language.
 * Deterministic: the same footprints give the same score on any machine.
 */

import type { WaveRiskLevel } from "../../shared/types/conflict-waves";
import { normalizePlanPath } from "../utils/plan-conflicts";

/** Two specs editing it nearly always conflict: manifests and lockfiles. */
const DEPENDENCY_FILES = new Set([
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
	"bun.lockb",
	"bun.lock",
	"deno.json",
	"deno.lock",
	"pyproject.toml",
	"poetry.lock",
	"uv.lock",
	"pipfile",
	"pipfile.lock",
	"setup.py",
	"setup.cfg",
	"go.mod",
	"go.sum",
	"go.work",
	"cargo.toml",
	"cargo.lock",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
	"gradle.properties",
	"libs.versions.toml",
	"gemfile",
	"gemfile.lock",
	"composer.json",
	"composer.lock",
	"pubspec.yaml",
	"pubspec.lock",
	"package.swift",
	"package.resolved",
	"podfile",
	"podfile.lock",
	"mix.exs",
	"mix.lock",
	"directory.packages.props",
	"directory.build.props",
	"packages.config",
	"cmakelists.txt",
	"conanfile.txt",
	"vcpkg.json",
	"build.sbt",
	"stack.yaml",
	"cabal.project",
]);

/** Suffixes of project files that list dependencies (.NET, Ruby, Haskell…). */
const DEPENDENCY_SUFFIXES = [
	".csproj",
	".fsproj",
	".vbproj",
	".sln",
	".slnx",
	".gemspec",
	".cabal",
	".nimble",
	".rockspec",
];

/** Shared configuration: read by every part of the build. */
const CONFIG_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.env(\.[^/]*)?$/,
	/(^|\/)[^/]*\.config\.[cm]?[jt]s$/,
	/(^|\/)tsconfig[^/]*\.json$/,
	/(^|\/)dockerfile[^/]*$/,
	/(^|\/)docker-compose[^/]*\.ya?ml$/,
	/(^|\/)makefile$/,
	/(^|\/)\.github\/workflows\//,
	/(^|\/)\.gitlab-ci\.ya?ml$/,
	/(^|\/)azure-pipelines[^/]*\.ya?ml$/,
	/(^|\/)appsettings[^/]*\.json$/,
	/\.(ya?ml|toml|ini|cfg|properties)$/,
];

/** Weight of one shared file: 3 dependency file, 2 shared config, 1 otherwise. */
export function fileWeight(normalizedPath: string): number {
	const base = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	if (DEPENDENCY_FILES.has(base)) return 3;
	if (/^requirements[^/]*\.(txt|in)$/.test(base)) return 3;
	if (DEPENDENCY_SUFFIXES.some((suffix) => base.endsWith(suffix))) return 3;
	if (CONFIG_PATTERNS.some((pattern) => pattern.test(normalizedPath))) return 2;
	return 1;
}

/** Risk level of a score; 0 is "none". */
export function riskLevel(score: number): WaveRiskLevel {
	if (score <= 0) return "none";
	if (score < 2) return "low";
	if (score < 4) return "medium";
	if (score < 8) return "high";
	return "critical";
}

/**
 * A spec's footprint: normalized path → the path as first written, so the
 * view shows readable paths while the comparison ignores case and slashes.
 */
export type Footprint = Map<string, string>;

export function buildFootprint(...lists: ReadonlyArray<readonly string[]>): Footprint {
	const footprint: Footprint = new Map();
	for (const list of lists) {
		for (const file of list) {
			if (typeof file !== "string" || file.trim() === "") continue;
			const normalized = normalizePlanPath(file);
			if (normalized && !footprint.has(normalized)) {
				footprint.set(normalized, file.trim().replaceAll("\\", "/"));
			}
		}
	}
	return footprint;
}

export interface PairScore {
	score: number;
	/** Display paths, sorted, every one of them. */
	shared: string[];
}

export function scorePair(a: Footprint, b: Footprint): PairScore {
	let score = 0;
	const shared: string[] = [];
	for (const [normalized, display] of a) {
		if (!b.has(normalized)) continue;
		score += fileWeight(normalized);
		shared.push(display);
	}
	shared.sort((x, y) => x.localeCompare(y));
	return { score, shared };
}

/**
 * Fragile zones (`fragile-zones.ts`): normalized path -> the files the
 * project's history changed together with it, often enough to count.
 */
export type CoChangeIndex = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Each coupled pair of files between two specs adds 1 to their score, at
 * most this much: the history hints, shared files decide.
 */
export const MAX_FRAGILE_WEIGHT = 3;

/**
 * Coupled files between two specs, one on each side and neither shared
 * (a shared file is already scored), as `x ↔ y` display pairs, sorted.
 */
export function fragileLinks(a: Footprint, b: Footprint, index: CoChangeIndex): string[] {
	const links = new Set<string>();
	for (const [x, shownX] of a) {
		if (b.has(x)) continue;
		for (const y of index.get(x) ?? []) {
			if (a.has(y) || !b.has(y)) continue;
			links.add(`${shownX} ↔ ${b.get(y) as string}`);
		}
	}
	return [...links].sort((p, q) => p.localeCompare(q));
}
