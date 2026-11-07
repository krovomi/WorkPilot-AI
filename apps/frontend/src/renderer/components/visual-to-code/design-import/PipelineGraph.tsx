import { Check, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DESIGN_STACK_INFO } from "../../../../shared/types/design-to-code";
import {
	DEFAULT_NOTE_KEYS,
	DESIGN_STEPS,
	type DesignStep,
	type DesignStepState,
	stepStates,
} from "../../../lib/design-import-steps";
import { useDesignToCodeStore } from "../../../stores/design-to-code-store";

const ACCENT: Record<DesignStep, string> = {
	vision: "var(--di-vision)",
	tokens: "var(--di-tokens)",
	spec: "var(--di-spec)",
	code: "var(--di-code)",
	tests: "var(--di-tests)",
	project: "var(--di-project)",
};

/** Steps alternate left and right so the wires curve between them. */
const OFFSET_RIGHT = new Set<DesignStep>(["tokens", "code", "project"]);
const NODE_HEIGHT = 80;

interface Wire {
	d: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	live: boolean;
}

function NoteText({ index }: { index: number }) {
	const { t } = useTranslation("designToCode");
	const custom = useDesignToCodeStore((s) => s.notes[index]);
	const setNote = useDesignToCodeStore((s) => s.setNote);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const text = custom ?? t(DEFAULT_NOTE_KEYS[index]);

	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	if (editing) {
		return (
			<textarea
				ref={inputRef}
				rows={3}
				value={draft}
				aria-label={t("pipeline.editNote")}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					setNote(index, draft === t(DEFAULT_NOTE_KEYS[index]) ? null : draft);
					setEditing(false);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						(event.target as HTMLTextAreaElement).blur();
					}
					if (event.key === "Escape") setEditing(false);
				}}
			/>
		);
	}
	return (
		<button
			type="button"
			className="di-note-text text-left italic"
			title={t("pipeline.editNote")}
			onClick={() => {
				setDraft(text);
				setEditing(true);
			}}
		>
			{text}
		</button>
	);
}

/**
 * The run as six steps on glowing wires. A step's card opens its result in
 * the inspector; the sentence between two steps says what passes from one
 * to the next, and the person can rewrite it.
 */
export function PipelineGraph() {
	const { t } = useTranslation("designToCode");
	const graphRef = useRef<HTMLDivElement>(null);
	const nodeRefs = useRef<Partial<Record<DesignStep, HTMLDivElement | null>>>({});
	const [height, setHeight] = useState(0);
	const [wires, setWires] = useState<Wire[]>([]);

	const phase = useDesignToCodeStore((s) => s.phase);
	const failedStep = useDesignToCodeStore((s) => s.failedStep);
	const framework = useDesignToCodeStore((s) => s.framework);
	const useDesignTokens = useDesignToCodeStore((s) => s.useDesignTokens);
	const generateTests = useDesignToCodeStore((s) => s.generateTests);
	const setUseDesignTokens = useDesignToCodeStore((s) => s.setUseDesignTokens);
	const setGenerateTests = useDesignToCodeStore((s) => s.setGenerateTests);
	const selectedStep = useDesignToCodeStore((s) => s.selectedStep);
	const selectStep = useDesignToCodeStore((s) => s.selectStep);
	const live = useDesignToCodeStore((s) => s.live);
	const result = useDesignToCodeStore((s) => s.result);
	const writeOutcome = useDesignToCodeStore((s) => s.writeOutcome);
	const designSystemPath = useDesignToCodeStore((s) => s.designSystemPath);

	const testsSupported = DESIGN_STACK_INFO[framework].visualTests;
	const states = stepStates({
		phase,
		failedStep,
		useDesignTokens,
		generateTests,
		testsSupported,
		written: Boolean(writeOutcome?.written.length),
	});
	const running = !["idle", "complete", "error"].includes(phase);

	const meta = (step: DesignStep, state: DesignStepState): string => {
		if (state === "off") return t("pipeline.off");
		if (state === "unsupported") return t("pipeline.testsUnsupported");
		const specCount = result?.design_spec?.components.length ?? live.spec?.components.length;
		switch (step) {
			case "vision":
				return specCount !== undefined && state !== "pending"
					? t("pipeline.meta.visionDone", {
							count: specCount,
							colors: Object.keys(result?.design_spec?.color_palette ?? live.spec?.palette ?? {}).length,
						})
					: t("pipeline.meta.vision");
			case "tokens": {
				const n = result?.design_tokens_used.length ?? live.tokens;
				return n !== null && n !== undefined && state === "done"
					? t("pipeline.meta.tokensDone", { count: n })
					: designSystemPath || t("pipeline.meta.tokens");
			}
			case "spec":
				return specCount !== undefined && state === "done"
					? t("pipeline.meta.specDone", { count: specCount })
					: t("pipeline.meta.spec");
			case "code": {
				const n = result?.generated_files.length ?? (live.files.length || undefined);
				return n !== undefined && state === "done"
					? t("pipeline.meta.codeDone", { count: n })
					: t("pipeline.meta.code", { stack: t(`stacks.${framework}`) });
			}
			case "tests":
				return state === "done" && result
					? t("pipeline.meta.testsDone", { count: result.visual_tests.length })
					: t("pipeline.meta.tests");
			case "project":
				if (writeOutcome) return t("pipeline.meta.projectWritten", { count: writeOutcome.written.length });
				return state === "ready"
					? t("pipeline.meta.projectReady", {
							count: (result?.generated_files.length ?? 0) + (result?.visual_tests.length ?? 0),
						})
					: t("pipeline.meta.project");
		}
	};

	// The graph is laid out from its height; the wires from the cards' boxes.
	useLayoutEffect(() => {
		const graph = graphRef.current;
		if (!graph) return;
		const measure = () => setHeight(graph.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(graph);
		return () => observer.disconnect();
	}, []);

	const step = Math.max(92, (height - NODE_HEIGHT) / (DESIGN_STEPS.length - 1));

	const liveWires = DESIGN_STEPS.slice(0, -1).map((s, i) => {
		const next = DESIGN_STEPS[i + 1];
		return states[s] === "done" && states[next] !== "pending";
	});

	// Runs after every render and only stores wires that changed: the cards
	// move with the height, a toggle or a state, and each of those renders.
	useLayoutEffect(() => {
		const graph = graphRef.current;
		if (!graph) return;
		const box = graph.getBoundingClientRect();
		const next: Wire[] = [];
		DESIGN_STEPS.slice(0, -1).forEach((s, i) => {
			const a = nodeRefs.current[s]?.getBoundingClientRect();
			const b = nodeRefs.current[DESIGN_STEPS[i + 1]]?.getBoundingClientRect();
			if (!a || !b) return;
			const x1 = a.left - box.left + a.width / 2;
			const y1 = a.bottom - box.top;
			const x2 = b.left - box.left + b.width / 2;
			const y2 = b.top - box.top;
			const my = (y2 - y1) * 0.6;
			next.push({
				d: `M${x1},${y1} C${x1},${y1 + my} ${x2},${y2 - my} ${x2},${y2}`,
				x1,
				y1,
				x2,
				y2,
				live: liveWires[i],
			});
		});
		setWires((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
	});

	const subtitle = running
		? t("pipeline.running")
		: phase === "complete" && result
			? t("pipeline.doneIn", { seconds: result.duration_seconds.toFixed(0) })
			: t("pipeline.stepCount", { count: DESIGN_STEPS.length });

	return (
		<section className="di-col" aria-label={t("pipeline.kicker")}>
			<div className="di-colhead">
				<div>
					<div className="di-kicker">{t("pipeline.kicker")}</div>
					<h2>{t("pipeline.title")}</h2>
				</div>
				<span className="di-sub">{subtitle}</span>
			</div>

			<div className="di-graph" ref={graphRef}>
				<svg className="di-wires" aria-hidden="true">
					{wires.map((w, i) => (
						<g key={DESIGN_STEPS[i]}>
							<path className="di-wire-glow" data-state={w.live ? "live" : "idle"} d={w.d} />
							<path className="di-wire" data-state={w.live ? "live" : "idle"} d={w.d} />
							{w.live && <path className="di-wire-spark" d={w.d} style={{ animationDelay: `-${i * 0.4}s` }} />}
							<circle className="di-wire-end" cx={w.x1} cy={w.y1} r={3} />
							<circle className="di-wire-end" cx={w.x2} cy={w.y2} r={3} />
						</g>
					))}
				</svg>

				{DESIGN_STEPS.map((s, i) => {
					const state = states[s];
					const right = OFFSET_RIGHT.has(s);
					const toggle =
						s === "tokens"
							? { on: useDesignTokens, set: setUseDesignTokens }
							: s === "tests" && testsSupported
								? { on: generateTests, set: setGenerateTests }
								: null;
					return (
						<div
							key={s}
							ref={(el) => {
								nodeRefs.current[s] = el;
							}}
							className="di-node"
							data-state={state}
							data-selected={selectedStep === s}
							style={{
								top: i * step,
								...(right ? { right: 0 } : { left: 0 }),
								["--di-accent" as string]: ACCENT[s],
							}}
						>
							<button
								type="button"
								className="di-node-hit"
								data-testid={`design-step-${s}`}
								aria-pressed={selectedStep === s}
								aria-label={t(`steps.${s}.title`)}
								onClick={() => selectStep(selectedStep === s ? null : s)}
							/>
							<div className="di-node-top">
								<span className="di-kicker">
									{t("pipeline.stepKicker", { n: i + 1, name: t(`steps.${s}.kicker`) })}
								</span>
								<span className="di-node-state" title={t(`stepStates.${state}`)}>
									{(state === "done" || state === "ready") && <Check className="h-3 w-3" />}
									{state === "error" && <X className="h-3 w-3" />}
								</span>
								{toggle && (
									<button
										type="button"
										role="switch"
										aria-checked={toggle.on}
										aria-label={t(`steps.${s}.toggle`)}
										disabled={running}
										className="di-switch"
										onClick={() => toggle.set(!toggle.on)}
									/>
								)}
							</div>
							<div className="di-node-title">{t(`steps.${s}.title`)}</div>
							<div className="di-node-meta">{meta(s, state)}</div>
						</div>
					);
				})}

				{DESIGN_STEPS.slice(1).map((s, i) => {
					// The sentence sits beside the step it leads to, on the free side.
					const nextRight = OFFSET_RIGHT.has(s);
					return (
						<div
							key={`note-${s}`}
							className="di-note"
							data-side={nextRight ? "left" : "right"}
							style={{
								top: (i + 1) * step + 14,
								...(nextRight ? { left: 0 } : { right: 0 }),
							}}
						>
							<NoteText index={i} />
						</div>
					);
				})}
			</div>
			<div className="di-legend">{t(phase === "complete" ? "pipeline.legendDone" : "pipeline.legend")}</div>
		</section>
	);
}
