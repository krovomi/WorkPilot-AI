import { FileCheck2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	TDD_SNIPPET_TYPES,
	TEST_STUDIO_LANGUAGES,
} from "../../../../shared/constants/test-studio-languages";
import type { useTestLibraries } from "../../../hooks/use-test-libraries";
import type { StudioMode } from "../../../lib/test-studio-steps";
import { SmartFilePicker } from "../SmartFilePicker";
import { TestLibrariesPicker } from "../TestLibrariesPicker";

interface TargetColumnProps {
	readonly mode: StudioMode;
	readonly running: boolean;
	readonly selectedFile: string;
	readonly onSelectFile: (path: string) => void;
	readonly existingTestPath: string | null;
	readonly coverageTarget: number;
	readonly onCoverageTarget: (value: number) => void;
	readonly userStory: string;
	readonly onUserStory: (value: string) => void;
	readonly targetModule: string;
	readonly onTargetModule: (value: string) => void;
	readonly tddDescription: string;
	readonly onTddDescription: (value: string) => void;
	/** The language picked, or "" while the project's own is used. */
	readonly tddLanguage: string;
	/** The project's language as the backend read it, for the "auto" chip. */
	readonly projectLanguage: string | undefined;
	readonly onTddLanguage: (value: string) => void;
	readonly tddSnippetType: string;
	readonly onTddSnippetType: (value: string) => void;
	readonly libraries: ReturnType<typeof useTestLibraries>;
	readonly canInstall: boolean;
}

/**
 * The first column: what the agent works on. A file for an analysis or unit
 * tests, a scenario for E2E, a behaviour still to write for TDD — and, for
 * every generation, the test libraries the file will be written against.
 */
export function TargetColumn(props: TargetColumnProps) {
	const { t } = useTranslation("testGeneration");
	const { mode, running, libraries } = props;
	const autoLanguage = TEST_STUDIO_LANGUAGES.find((l) => l.id === props.projectLanguage);

	return (
		<section className="tg-col" aria-label={t("studio.target.kicker")}>
			<div className="tg-colhead">
				<div>
					<div className="tg-kicker">{t("studio.target.kicker")}</div>
					<h3>{t(`studio.target.title.${mode}`)}</h3>
				</div>
			</div>

			<div className="tg-scroll">
				<div className="tg-card tg-intro">
					<strong>{t(`studio.intro.${mode}.title`)}</strong>
					{t(`studio.intro.${mode}.body`)}
				</div>

				{(mode === "analyze" || mode === "unit") && (
					<div className="tg-field">
						<div className="tg-label">{t("sourceFile.label")}</div>
						<SmartFilePicker
							value={props.selectedFile}
							onChange={props.onSelectFile}
							tabType={mode}
							placeholder={t("filePicker.selectFile")}
						/>
						{props.existingTestPath && (
							<span className="tg-chip" title={props.existingTestPath}>
								<FileCheck2 className="h-3 w-3" />
								{t("studio.target.existingTest")}{" "}
								<b>{props.existingTestPath.split(/[\\/]/).pop()}</b>
							</span>
						)}
					</div>
				)}

				{mode === "unit" && (
					<div className="tg-field">
						<label className="tg-label" htmlFor="tg-coverage">
							{t("coverageTarget.label")}
							<span>{t("studio.target.coverageHint")}</span>
						</label>
						<div className="tg-range">
							<input
								id="tg-coverage"
								type="range"
								min={10}
								max={100}
								step={5}
								value={props.coverageTarget}
								disabled={running}
								onChange={(e) =>
									props.onCoverageTarget(Number.parseInt(e.target.value, 10))
								}
							/>
							<output htmlFor="tg-coverage">{props.coverageTarget}%</output>
						</div>
					</div>
				)}

				{mode === "e2e" && (
					<>
						<div className="tg-field">
							<label className="tg-label" htmlFor="tg-story">
								{t("userStory.label")}
								<span>{t("studio.target.storyHint")}</span>
							</label>
							<textarea
								id="tg-story"
								className="tg-textarea"
								rows={6}
								value={props.userStory}
								disabled={running}
								onChange={(e) => props.onUserStory(e.target.value)}
								placeholder={t("studio.target.storyPlaceholder")}
							/>
						</div>
						<div className="tg-field">
							<div className="tg-label">
								{t("targetModule.label")}
								<span>{t("studio.target.targetHint")}</span>
							</div>
							<SmartFilePicker
								value={looksLikeFile(props.targetModule) ? props.targetModule : ""}
								onChange={props.onTargetModule}
								tabType="unit"
								placeholder={t("filePicker.selectFile")}
							/>
							<div className="tg-or">{t("studio.target.or")}</div>
							<input
								className="tg-input"
								aria-label={t("targetModule.label")}
								value={looksLikeFile(props.targetModule) ? "" : props.targetModule}
								disabled={running}
								onChange={(e) => props.onTargetModule(e.target.value)}
								placeholder={t("studio.target.targetPlaceholder")}
							/>
						</div>
					</>
				)}

				{mode === "tdd" && (
					<>
						<div className="tg-field">
							<label className="tg-label" htmlFor="tg-tdd">
								{t("tdd.description.label")}
							</label>
							<textarea
								id="tg-tdd"
								className="tg-textarea"
								rows={6}
								value={props.tddDescription}
								disabled={running}
								onChange={(e) => props.onTddDescription(e.target.value)}
								placeholder={t("tdd.description.placeholder")}
							/>
						</div>
						<div className="tg-field">
							<div className="tg-label">
								{t("studio.target.language")}
								<span>{t("studio.target.languageHint")}</span>
							</div>
							<fieldset className="tg-options" aria-label={t("studio.target.language")}>
								<button
									type="button"
									className="tg-option"
									aria-pressed={props.tddLanguage === ""}
									disabled={running}
									onClick={() => props.onTddLanguage("")}
									style={{ ["--tg-accent" as string]: autoLanguage?.color }}
								>
									<i />
									{t("studio.target.auto")}
									{autoLanguage && <small>{autoLanguage.label}</small>}
								</button>
								{TEST_STUDIO_LANGUAGES.map((lang) => (
									<button
										key={lang.id}
										type="button"
										className="tg-option"
										aria-pressed={props.tddLanguage === lang.id}
										disabled={running}
										title={lang.framework}
										onClick={() => props.onTddLanguage(lang.id)}
										style={{ ["--tg-accent" as string]: lang.color }}
									>
										<i />
										{lang.label}
									</button>
								))}
							</fieldset>
						</div>
						<div className="tg-field">
							<div className="tg-label">{t("snippetType.label")}</div>
							<fieldset className="tg-options" aria-label={t("snippetType.label")}>
								{TDD_SNIPPET_TYPES.map((type) => (
									<button
										key={type}
										type="button"
										className="tg-option"
										aria-pressed={props.tddSnippetType === type}
										disabled={running}
										onClick={() => props.onTddSnippetType(type)}
									>
										{t(`snippetType.options.${type}`)}
									</button>
								))}
							</fieldset>
						</div>
					</>
				)}

				{mode !== "analyze" &&
					!libraries.loading &&
					!libraries.selection?.libraries.length && (
						<p className="tg-help">
							{t("studio.target.noLibraries")}
						</p>
					)}

				{mode !== "analyze" && (
					<div className="tg-field">
						<TestLibrariesPicker
							compact
							selection={libraries.selection}
							chosen={libraries.chosen}
							missing={libraries.missing}
							loading={libraries.loading}
							installing={libraries.installing}
							report={libraries.report}
							error={libraries.error}
							onToggle={libraries.toggle}
							onReset={libraries.resetToProject}
							onAddPackages={() => void libraries.addMissingPackages()}
							canInstall={props.canInstall}
						/>
					</div>
				)}
			</div>
		</section>
	);
}

/**
 * A file picked in the tree (an absolute path) rather than a module typed by
 * hand, which stays in the text field even when it ends in an extension.
 */
export function looksLikeFile(value: string): boolean {
	return /^(?:[A-Za-z]:[\\/]|\/)/.test(value) && /\.[A-Za-z0-9]{1,6}$/.test(value);
}
