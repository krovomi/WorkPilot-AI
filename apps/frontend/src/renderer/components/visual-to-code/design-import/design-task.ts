import type { TFunction } from "i18next";
import type { DesignToCodeResult } from "../../../../shared/types/design-to-code";

/** The Kanban task carries the generated code, capped so a task stays readable. */
const MAX_CODE_CHARS = 40_000;

interface DesignTaskState {
	framework: string;
	style: string | null;
	customInstructions: string;
	result: DesignToCodeResult | null;
}

/**
 * A Kanban task that asks the agent to integrate the imported design: the
 * components found, the stack, the person's instructions, and the generated
 * files as a starting point. The agent then works in its own worktree, with
 * the build, the tests and the review of a normal task.
 */
export function buildDesignTaskDescription(
	state: DesignTaskState,
	t: TFunction,
): string {
	const result = state.result;
	if (!result) return "";
	const stack = t(`designToCode:stacks.${state.framework}`);
	const lines: string[] = [
		t("designToCode:kanban.intro", { stack }),
		"",
	];
	if (state.style) {
		lines.push(t("designToCode:kanban.style", { style: t(`designToCode:styles.${state.style}`) }), "");
	}
	if (state.customInstructions.trim()) {
		lines.push(`## ${t("designToCode:kanban.instructions")}`, state.customInstructions.trim(), "");
	}
	const components = result.design_spec?.components ?? [];
	if (components.length) {
		lines.push(`## ${t("designToCode:kanban.components")}`);
		for (const c of components) {
			const children = c.children.map((ch) => ch.name).join(", ");
			lines.push(`- ${c.name} (${c.type})${children ? `: ${children}` : ""}`);
		}
		lines.push("");
	}
	const palette = Object.entries(result.design_spec?.color_palette ?? {});
	if (palette.length) {
		lines.push(`## ${t("designToCode:kanban.palette")}`);
		lines.push(palette.map(([name, value]) => `${name}: ${value}`).join(", "), "");
	}
	lines.push(`## ${t("designToCode:kanban.files")}`);
	let budget = MAX_CODE_CHARS;
	for (const file of [
		...result.generated_files.map((f) => ({ path: f.path, content: f.content })),
		...result.visual_tests.map((v) => ({ path: v.path ?? v.name, content: v.test_code })),
	]) {
		if (budget <= 0) {
			lines.push(`- ${file.path}`);
			continue;
		}
		const content = file.content.slice(0, budget);
		budget -= content.length;
		lines.push(`### ${file.path}`, "```", content, "```", "");
	}
	return lines.join("\n");
}
