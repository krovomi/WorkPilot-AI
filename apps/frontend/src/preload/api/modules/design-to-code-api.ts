/**
 * Design-to-Code API — preload bridge for the "Import Design" pipeline
 * (design image → structured spec → generated code).
 */
import { ipcRenderer } from "electron";

export interface DesignToCodeRequest {
	imageData?: string;
	framework?: string;
	sourceType?: string;
	designSystemPath?: string;
	figmaUrl?: string;
	generateTests?: boolean;
	customInstructions?: string;
}

export interface DesignToCodeGeneratedFile {
	path: string;
	content: string;
	language: string;
	description: string;
}

export interface DesignToCodePipelineResult {
	success: boolean;
	phase: string;
	design_spec: unknown;
	generated_files: DesignToCodeGeneratedFile[];
	visual_tests: unknown[];
	design_tokens_used: unknown[];
	figma_sync_status: Record<string, unknown> | null;
	errors: string[];
	warnings: string[];
	duration_seconds: number;
	tokens_used: number;
}

export interface DesignToCodeAPI {
	runDesignToCodePipeline: (
		request: DesignToCodeRequest,
	) => Promise<DesignToCodePipelineResult>;
}

export function createDesignToCodeAPI(): DesignToCodeAPI {
	return {
		runDesignToCodePipeline: (request) =>
			ipcRenderer.invoke("designToCode:run", request),
	};
}
