import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { runOneShotLLM } from "./oneshot-llm";

export interface GeneratedFile {
	filename: string;
	language: string;
	content: string;
}

export interface GenerateCodeResult {
	files: GeneratedFile[];
	summary: string;
	instructions: string;
}

export interface DiagramNode {
	id: string;
	label: string;
	type: string;
	framework: string;
}

export interface DiagramEdge {
	source: string;
	target: string;
	label: string;
}

export interface CodeToVisualResult {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
	summary: string;
}

export interface VisualProgrammingRequest {
	action: "generate-code" | "code-to-visual";
	// generate-code
	diagramJson?: string;
	framework?: string;
	// code-to-visual
	filePath?: string;
	projectPath?: string;
}

interface RawNode {
	id?: string;
	data?: { label?: string; type?: string; framework?: string };
}
interface RawEdge {
	source?: string;
	target?: string;
	data?: { label?: string };
}

/**
 * Service for visual programming AI features.
 *
 * Provider-agnostic: the actual LLM call goes through `runOneShotLLM`, which
 * routes to whatever provider the user selected (Claude, Copilot, OpenAI,
 * Ollama, Windsurf, …) — nothing here is Claude-specific. Prompts are built
 * here and the model returns JSON we parse.
 *
 * Events:
 * - 'status'  (msg: string)  — progress update
 * - 'error'   (err: string)  — error message
 * - 'complete' ({ action, data }) — done
 */
export class VisualProgrammingService extends EventEmitter {
	private pythonPath: string | undefined;
	private sourcePath: string | undefined;
	private cancelled = false;

	configure(pythonPath?: string, sourcePath?: string): void {
		if (pythonPath) this.pythonPath = pythonPath;
		if (sourcePath) this.sourcePath = sourcePath;
	}

	cancel(): boolean {
		this.cancelled = true;
		return true;
	}

	async run(request: VisualProgrammingRequest): Promise<void> {
		this.cancelled = false;
		try {
			if (request.action === "generate-code") {
				await this.runGenerateCode(request);
			} else {
				await this.runCodeToVisual(request);
			}
		} catch (error) {
			this.emit(
				"error",
				error instanceof Error ? error.message : "Unknown error",
			);
		}
	}

	// ── generate-code ───────────────────────────────────────────────────
	private async runGenerateCode(
		request: VisualProgrammingRequest,
	): Promise<void> {
		if (!request.diagramJson) {
			this.emit("error", "diagramJson is required for generate-code");
			return;
		}
		let diagram: { nodes?: RawNode[]; edges?: RawEdge[]; diagramType?: string };
		try {
			diagram = JSON.parse(request.diagramJson);
		} catch (err) {
			this.emit(
				"error",
				`Invalid diagram JSON: ${err instanceof Error ? err.message : err}`,
			);
			return;
		}

		this.emit("status", "Analyzing diagram...");
		const prompt = buildGenerateCodePrompt(diagram, request.framework ?? "");
		this.emit("status", "Generating code...");

		const text = await runOneShotLLM({
			prompt,
			systemPrompt:
				"You are an expert software architect that converts visual diagrams into production-ready source code. Always respond with valid JSON only.",
			pythonPath: this.pythonPath,
			autoBuildSourcePath: this.sourcePath,
			timeoutMs: 120000,
			debugLabel: "VisualProgramming",
		});
		if (this.cancelled) return;
		if (!text) {
			this.emit(
				"error",
				"The model returned no output (check the selected provider's credentials).",
			);
			return;
		}

		this.emit("status", "Parsing response...");
		const result = parseJsonLoose<GenerateCodeResult>(text);
		if (!result) {
			this.emit("error", "Could not parse the model response as JSON.");
			return;
		}
		this.emit("complete", { action: "generate-code", data: result });
	}

	// ── code-to-visual ──────────────────────────────────────────────────
	private async runCodeToVisual(
		request: VisualProgrammingRequest,
	): Promise<void> {
		if (!request.filePath) {
			this.emit("error", "filePath is required for code-to-visual");
			return;
		}
		if (!existsSync(request.filePath)) {
			this.emit("error", `File not found: ${request.filePath}`);
			return;
		}
		let source: string;
		try {
			source = readFileSync(request.filePath, "utf-8");
		} catch (err) {
			this.emit(
				"error",
				`Cannot read file: ${err instanceof Error ? err.message : err}`,
			);
			return;
		}
		const fileName = request.filePath.split(/[\\/]/).pop() ?? request.filePath;

		this.emit("status", `Analyzing ${fileName}...`);
		const prompt = buildCodeToVisualPrompt(source, fileName);
		this.emit("status", "Extracting structure...");

		const text = await runOneShotLLM({
			prompt,
			systemPrompt:
				"You are an expert software architect that extracts visual diagram structures from source code. Always respond with valid JSON only.",
			projectDir: request.projectPath,
			pythonPath: this.pythonPath,
			autoBuildSourcePath: this.sourcePath,
			timeoutMs: 120000,
			debugLabel: "VisualProgramming",
		});
		if (this.cancelled) return;
		if (!text) {
			this.emit(
				"error",
				"The model returned no output (check the selected provider's credentials).",
			);
			return;
		}

		this.emit("status", "Parsing response...");
		const result = parseJsonLoose<CodeToVisualResult>(text);
		if (!result) {
			this.emit("error", "Could not parse the model response as JSON.");
			return;
		}
		this.emit("complete", { action: "code-to-visual", data: result });
	}
}

// ── Prompt builders (provider-neutral) ────────────────────────────────

function buildGenerateCodePrompt(
	diagram: { nodes?: RawNode[]; edges?: RawEdge[]; diagramType?: string },
	framework: string,
): string {
	const nodes = diagram.nodes ?? [];
	const edges = diagram.edges ?? [];
	const diagramType = diagram.diagramType ?? "flowchart";

	const nodesDesc =
		nodes
			.map(
				(n) =>
					`  - [${n.id ?? "?"}] ${n.data?.label ?? "Unnamed"} (type: ${n.data?.type ?? "default"}, framework: ${n.data?.framework ?? ""})`,
			)
			.join("\n") || "  (no nodes)";
	const edgesDesc =
		edges
			.map((e) => {
				const label = e.data?.label ? ` [${e.data.label}]` : "";
				return `  - ${e.source ?? "?"} → ${e.target ?? "?"}${label}`;
			})
			.join("\n") || "  (no connections)";

	return `You are an expert software architect and developer.

The user has designed a ${diagramType} diagram using a visual no-code editor.
Your task is to generate production-ready source code that implements the architecture shown.

## Diagram Nodes
${nodesDesc}

## Connections (Edges)
${edgesDesc}

## Target Framework / Technology
${framework || "Auto-detect from node labels"}

## Instructions
1. Analyse the diagram structure carefully.
2. Generate well-structured, commented source code implementing the described architecture.
3. For each node, create the corresponding file/module/component.
4. Respect the connections (edges) as dependencies or data flows between modules.
5. Return a JSON object with this exact structure:

{
  "files": [
    { "filename": "relative/path/to/File.ext", "language": "typescript", "content": "// full file content here" }
  ],
  "summary": "Brief description of what was generated",
  "instructions": "How to run / integrate the generated code"
}

Respond with ONLY the JSON object, no markdown fences, no explanation outside the JSON.`;
}

function buildCodeToVisualPrompt(sourceCode: string, fileName: string): string {
	return `You are an expert software architect.

Analyse the following source file and extract its structure as a visual diagram
(nodes and edges compatible with ReactFlow).

## File: ${fileName}
\`\`\`
${sourceCode.slice(0, 8000)}
\`\`\`

## Instructions
Return a JSON object with this exact structure:

{
  "nodes": [
    { "id": "unique-string", "label": "Human-readable name", "type": "component|function|class|module|service|database|api|custom", "framework": "React|Angular|Python|etc (or empty string)" }
  ],
  "edges": [
    { "source": "node-id", "target": "node-id", "label": "optional relationship label" }
  ],
  "summary": "One-sentence description of what this file does"
}

Rules:
- Every import, class, function, or component becomes a node.
- Dependencies (imports, calls) become directed edges.
- Keep node labels short and human-readable.
- Respond with ONLY the JSON object, no markdown fences.`;
}

/** Parse model JSON, tolerating ```json fences around it. */
function parseJsonLoose<T>(raw: string): T | null {
	let text = raw.trim();
	if (text.startsWith("```")) {
		text = text
			.split("\n")
			.filter((line) => !line.trim().startsWith("```"))
			.join("\n")
			.trim();
	}
	// Fall back to the outermost {...} if there's surrounding prose.
	if (!text.startsWith("{")) {
		const first = text.indexOf("{");
		const last = text.lastIndexOf("}");
		if (first !== -1 && last > first) text = text.slice(first, last + 1);
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

export const visualProgrammingService = new VisualProgrammingService();
