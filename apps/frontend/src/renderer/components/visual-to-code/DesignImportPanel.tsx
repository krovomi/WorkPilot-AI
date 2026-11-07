import { useEffect } from "react";
import {
	detectDesignStack,
	useDesignToCodeStore,
} from "../../stores/design-to-code-store";
import { useProjectStore } from "../../stores/project-store";
import { DesignComposer } from "./design-import/DesignComposer";
import { PipelineGraph } from "./design-import/PipelineGraph";
import { ResultInspector } from "./design-import/ResultInspector";
import { SourceColumn } from "./design-import/SourceColumn";
import "./design-import/design-import.css";

/**
 * Import Design — a design (screenshot, Figma export, wireframe, whiteboard
 * photo) turned into code for the selected project's stack.
 *
 * Three columns: the design, the pipeline the agent runs (six steps on
 * wires, with the sentences between them), and the result of the step
 * picked. The composer at the bottom holds the instructions, the target and
 * the action of the moment. Nothing reaches the project before the person
 * clicks "write".
 */
export function DesignImportPanel() {
	const projectId = useProjectStore((s) => s.selectedProjectId);
	const resetPipeline = useDesignToCodeStore((s) => s.resetPipeline);

	// The page is unmounted when the person leaves it: coming back keeps the
	// run and its result. Only another project starts over, with its stack.
	useEffect(() => {
		const state = useDesignToCodeStore.getState();
		if (state.projectId !== projectId) {
			useDesignToCodeStore.setState({
				projectId,
				stackChosen: false,
				detection: null,
				designSystemPath: "",
			});
			const running = !["idle", "complete", "error"].includes(state.phase);
			if (!running) resetPipeline();
			void detectDesignStack(projectId);
		}
	}, [projectId, resetPipeline]);

	return (
		<div className="di-root" data-testid="design-import">
			<div className="di-ambient" />
			<div className="di-stage">
				<SourceColumn />
				<PipelineGraph />
				<ResultInspector />
			</div>
			<DesignComposer />
		</div>
	);
}
