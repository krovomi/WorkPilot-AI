import { Check, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { testStudioLanguage } from "../../../../shared/constants/test-studio-languages";
import {
	liveWires,
	STUDIO_STEPS,
	type StudioMode,
	type StudioStep,
	type StudioStepState,
} from "../../../lib/test-studio-steps";
import { useTestGenerationStore } from "../../../stores/test-generation-store";

const ACCENT: Record<StudioStep, string> = {
	scenario: "var(--tg-input)",
	spec: "var(--tg-input)",
	detect: "var(--tg-detect)",
	read: "var(--tg-read)",
	analyze: "var(--tg-analyze)",
	gaps: "var(--tg-gaps)",
	generate: "var(--tg-generate)",
	write: "var(--tg-write)",
};

const NODE_HEIGHT = 80;

interface Wire {
	d: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	live: boolean;
}

interface StudioPipelineProps {
	readonly mode: StudioMode;
	readonly states: Record<StudioStep, StudioStepState>;
	readonly selected: StudioStep | null;
	readonly onSelect: (step: StudioStep | null) => void;
	/** First words of the scenario or spec, shown on the input card. */
	readonly inputPreview: string;
	readonly tddLanguage: string;
}

/**
 * The run as four steps on glowing wires. A card opens its part of the result
 * in the inspector; the sentence between two cards says what passes from one
 * to the next.
 */
export function StudioPipeline({
	mode,
	states,
	selected,
	onSelect,
	inputPreview,
	tddLanguage,
}: StudioPipelineProps) {
	const { t } = useTranslation("testGeneration");
	const graphRef = useRef<HTMLDivElement>(null);
	const nodeRefs = useRef<Partial<Record<StudioStep, HTMLDivElement | null>>>({});
	const [height, setHeight] = useState(0);
	const [wires, setWires] = useState<Wire[]>([]);

	const phase = useTestGenerationStore((s) => s.phase);
	const liveStages = useTestGenerationStore((s) => s.liveStages);
	const liveMeta = useTestGenerationStore((s) => s.liveMeta);
	const result = useTestGenerationStore((s) => s.result);
	const coverageGaps = useTestGenerationStore((s) => s.coverageGaps);
	const runKind = useTestGenerationStore((s) => s.runKind);
	const genStartedAt = useTestGenerationStore((s) => s.genStartedAt);
	const genEndedAt = useTestGenerationStore((s) => s.genEndedAt);

	const steps = STUDIO_STEPS[mode];
	const ours = runKind === mode;
	const running = ours && (phase === "analyzing" || phase === "generating");
	const wiresLive = liveWires(mode, states);

	const meta = (step: StudioStep, state: StudioStepState): string => {
		if (state === "skipped") return t("studio.pipeline.skipped");
		if (state === "error") return t("studio.pipeline.failedHere");
		switch (step) {
			case "scenario":
			case "spec":
				return inputPreview || t(`studio.steps.${step}.meta`);
			case "detect":
				if (ours && liveMeta.language) {
					const label = testStudioLanguage(liveMeta.language)?.label ?? liveMeta.language;
					return `${label} · ${liveMeta.framework ?? "…"}`;
				}
				if (mode === "tdd" && tddLanguage) {
					return testStudioLanguage(tddLanguage)?.label ?? tddLanguage;
				}
				return t("studio.steps.detect.meta");
			case "read": {
				const lines = ours ? liveStages.find((s) => s.id === "read")?.lines : undefined;
				return typeof lines === "number"
					? t("live.stageLines", { count: lines })
					: t("studio.steps.read.meta");
			}
			case "analyze":
				return state === "done" && coverageGaps
					? t("studio.pipeline.gapsFound", { count: coverageGaps.length })
					: t("studio.steps.analyze.meta");
			case "gaps":
				if (state === "done" && coverageGaps) {
					const high = coverageGaps.filter((g) => g.priority === "high").length;
					return t("studio.pipeline.highPriority", { count: high });
				}
				return t("studio.steps.gaps.meta");
			case "generate": {
				const tests = ours ? (liveMeta.tests ?? result?.tests_generated) : undefined;
				return state === "done" && typeof tests === "number"
					? t("studio.pipeline.testsWritten", { count: tests })
					: t(`studio.steps.generate.meta.${mode}`);
			}
			case "write": {
				const path = ours ? (result?.test_file_path ?? liveMeta.path) : undefined;
				return state === "done" && path
					? (path.split(/[\\/]/).pop() ?? path)
					: t("studio.steps.write.meta");
			}
		}
	};

	useLayoutEffect(() => {
		const graph = graphRef.current;
		if (!graph) return;
		const measure = () => setHeight(graph.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(graph);
		return () => observer.disconnect();
	}, []);

	const rowStep = Math.max(100, (height - NODE_HEIGHT) / (steps.length - 1));

	// Runs after every render and stores only wires that changed: the cards
	// move with the height, the mode and each state.
	useLayoutEffect(() => {
		const graph = graphRef.current;
		if (!graph) return;
		const box = graph.getBoundingClientRect();
		const next: Wire[] = [];
		steps.slice(0, -1).forEach((s, i) => {
			const a = nodeRefs.current[s]?.getBoundingClientRect();
			const b = nodeRefs.current[steps[i + 1]]?.getBoundingClientRect();
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
				live: wiresLive[i],
			});
		});
		setWires((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
	});

	const seconds =
		genStartedAt && genEndedAt ? ((genEndedAt - genStartedAt) / 1000).toFixed(1) : null;
	const subtitle = running
		? t("studio.pipeline.running")
		: ours && phase === "complete" && seconds
			? t("studio.pipeline.doneIn", { seconds })
			: ours && phase === "error"
				? t("studio.pipeline.stopped")
				: t("studio.pipeline.stepCount", { count: steps.length });

	return (
		<section className="tg-col" aria-label={t("studio.pipeline.kicker")}>
			<div className="tg-colhead">
				<div>
					<div className="tg-kicker">{t("studio.pipeline.kicker")}</div>
					<h3>{t(`studio.pipeline.title.${mode}`)}</h3>
				</div>
				<span className="tg-sub">{subtitle}</span>
			</div>

			<div className="tg-graph" ref={graphRef}>
				<svg className="tg-wires" aria-hidden="true">
					{wires.map((w, i) => (
						<g key={`${mode}-${steps[i]}`}>
							<path className="tg-wire-glow" data-state={w.live ? "live" : "idle"} d={w.d} />
							<path className="tg-wire" data-state={w.live ? "live" : "idle"} d={w.d} />
							{w.live && (
								<path
									className="tg-wire-spark"
									d={w.d}
									style={{ animationDelay: `-${i * 0.4}s` }}
								/>
							)}
							<circle className="tg-wire-end" cx={w.x1} cy={w.y1} r={3} />
							<circle className="tg-wire-end" cx={w.x2} cy={w.y2} r={3} />
						</g>
					))}
				</svg>

				{steps.map((step, i) => {
					const state = states[step];
					const right = i % 2 === 1;
					return (
						<div
							key={`${mode}-${step}`}
							ref={(el) => {
								nodeRefs.current[step] = el;
							}}
							className="tg-node"
							data-state={state}
							data-selected={selected === step}
							style={{
								top: i * rowStep,
								...(right ? { right: 0 } : { left: 0 }),
								["--tg-accent" as string]: ACCENT[step],
							}}
						>
							<button
								type="button"
								className="tg-node-hit"
								data-testid={`test-studio-step-${step}`}
								aria-pressed={selected === step}
								aria-label={t(`studio.steps.${step}.title`)}
								onClick={() => onSelect(selected === step ? null : step)}
							/>
							<div className="tg-node-top">
								<span className="tg-kicker">
									{t("studio.pipeline.stepKicker", {
										n: i + 1,
										name: t(`studio.steps.${step}.kicker`),
									})}
								</span>
								<span className="tg-node-state" title={t(`studio.stepStates.${state}`)}>
									{state === "done" && <Check className="h-3 w-3" />}
									{state === "error" && <X className="h-3 w-3" />}
								</span>
							</div>
							<div className="tg-node-title">{t(`studio.steps.${step}.title`)}</div>
							<div className="tg-node-meta">{meta(step, state)}</div>
						</div>
					);
				})}

				{steps.slice(1).map((step, i) => {
					// The sentence sits beside the card it leads to, on the free side.
					const nextRight = (i + 1) % 2 === 1;
					return (
						<div
							key={`${mode}-note-${step}`}
							className="tg-note"
							data-side={nextRight ? "left" : "right"}
							style={{
								top: (i + 1) * rowStep + 14,
								...(nextRight ? { left: 0 } : { right: 0 }),
							}}
						>
							{t(`studio.notes.${mode}.${i}`)}
						</div>
					);
				})}
			</div>
			<div className="tg-legend">{t("studio.pipeline.legend")}</div>
		</section>
	);
}
