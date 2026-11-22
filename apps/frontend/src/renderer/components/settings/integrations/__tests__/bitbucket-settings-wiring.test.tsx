/**
 * Where the Bitbucket settings show up: the project settings route its
 * section to the Bitbucket form (behind the initialization guard), and the
 * CI/CD loop offers Bitbucket Pipelines, whose credentials come from that
 * section.
 *
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { ProjectEnvConfig } from "../../../../../shared/types";
import { SectionRouter } from "../../sections/SectionRouter";
import { CICDPipelineIntegration } from "../CICDPipelineIntegration";

type RouterProps = ComponentProps<typeof SectionRouter>;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		detectRepoProvider: () => Promise.resolve({ success: false }),
		bitbucket: { checkConnection: () => Promise.resolve({ success: false }) },
	};
});

describe("Bitbucket settings wiring", () => {
	it("routes the bitbucket section to the Bitbucket form", () => {
		render(
			<SectionRouter
				{...({} as RouterProps)}
				activeSection="bitbucket"
				project={{ id: "p1", name: "web", path: "/repo", autoBuildPath: ".workpilot" } as RouterProps["project"]}
				envConfig={{ bitbucketEnabled: false } as ProjectEnvConfig}
				updateEnvConfig={() => undefined}
			/>,
		);
		expect(screen.getAllByText("Bitbucket Integration").length).toBeGreaterThan(0);
		expect(screen.getByRole("switch", { name: "Enable Bitbucket" })).toBeInTheDocument();
	});

	it("names the Bitbucket section as where Bitbucket Pipelines' credentials live", () => {
		render(
			<CICDPipelineIntegration
				envConfig={{ cicdProvider: "bitbucket" } as ProjectEnvConfig}
				updateEnvConfig={() => undefined}
			/>,
		);
		expect(screen.getByText("Bitbucket Pipelines")).toBeInTheDocument();
		expect(screen.getByText(/from the Bitbucket integration section/)).toBeInTheDocument();
	});
});
