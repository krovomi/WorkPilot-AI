import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { runOneShotLLM } from "./oneshot-llm";
import { GeneratedFileStream } from "./visual-programming-stream";

export interface GeneratedFile {
	filename: string;
	language: string;
	content: string;
}

export interface GenerateCodeResult {
	files: GeneratedFile[];
	summary: string;
	instructions: string;
	/**
	 * The run ended without a parseable answer, and these are the files that
	 * were already complete when it did. Set on a timeout or a truncated
	 * response; the UI says so rather than presenting them as the whole answer.
	 */
	truncated?: boolean;
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

/** Long enough for a multi-file answer; see the call site for why. */
const GENERATE_CODE_TIMEOUT_MS = 300_000;

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
 * - 'file'    (file)          — a generated file, the moment its JSON closes
 * - 'writing' (filename)      — the file the model is currently writing
 * - 'error'   (err: string)  — error message
 * - 'complete' ({ action, data }) — done
 *
 * `file` and `writing` exist because the answer is one JSON object that is
 * only parseable once its last brace arrives: without them a generation is a
 * spinner for as long as it runs, however much has already been produced. They
 * are a *view* onto the run, never the result — `complete` still carries the
 * parsed answer, and a caller may ignore both and lose nothing but the wait.
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

		const stream = new GeneratedFileStream();
		const collected: GeneratedFile[] = [];
		const text = await runOneShotLLM({
			prompt,
			systemPrompt:
				"You are an expert software architect that converts visual diagrams into production-ready source code. Always respond with valid JSON only.",
			pythonPath: this.pythonPath,
			autoBuildSourcePath: this.sourcePath,
			// A whole project's worth of files is minutes of output, not the
			// seconds a one-shot utility needs. At two minutes a real answer was
			// being killed mid-file and reported as "the model returned no
			// output", which reads as a credentials problem.
			timeoutMs: GENERATE_CODE_TIMEOUT_MS,
			debugLabel: "VisualProgramming",
			onDelta: (chunk) => {
				// A cancelled run stops *reporting* here; the child process is
				// still finishing, and emitting into a UI that has moved on is
				// how a cancelled generation repopulates itself.
				if (this.cancelled) return;
				const { files, writing } = stream.push(chunk);
				for (const file of files) {
					collected.push(file);
					this.emit("file", file);
				}
				if (writing) this.emit("writing", writing);
			},
		});
		if (this.cancelled) return;

		this.emit("status", "Parsing response...");
		const result = text ? parseJsonLoose<GenerateCodeResult>(text) : null;
		if (result) {
			this.emit("complete", { action: "generate-code", data: result });
			return;
		}

		// No parseable answer. What the stream already read is still true — the
		// files it reported are the ones whose own JSON closed — so a run killed
		// by the timeout hands back everything it finished instead of throwing
		// away ten minutes of output over its last, half-written file.
		if (collected.length > 0) {
			this.emit("complete", {
				action: "generate-code",
				data: {
					files: collected,
					summary: "",
					instructions: "",
					truncated: true,
				} satisfies GenerateCodeResult,
			});
			return;
		}

		this.emit(
			"error",
			text
				? "Could not parse the model response as JSON."
				: "The model returned no output (check the selected provider's credentials, or that the request did not time out).",
		);
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
