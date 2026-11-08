import { AlertTriangle, Crosshair, FileCode2, Radar, Target } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useBlastRadiusStore } from "../../stores/blast-radius-store";
import {
	CharterButton,
	Chip,
	Chips,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Stat,
	Stats,
	type Tone,
} from "../charter";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const SCORE_TONES: Record<"low" | "medium" | "high", Tone> = {
	low: "green",
	medium: "amber",
	high: "red",
};

interface Props {
	readonly projectRoot?: string;
}

/** Which files a change to the targets reaches, and the tests that cover them. */
export function BlastRadiusView({ projectRoot }: Props) {
	const { t } = useTranslation(["blastRadius", "navigation"]);
	const { report, loading, error, analyze } = useBlastRadiusStore();
	const [rootInput, setRootInput] = useState(projectRoot ?? "");
	const [targetsInput, setTargetsInput] = useState("");

	const handleAnalyze = () => {
		const targets = targetsInput
			.split(/[\n,]/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (!rootInput.trim() || targets.length === 0) return;
		void analyze(rootInput.trim(), targets);
	};

	return (
		<ModuleStage data-testid="blast-radius-view">
			<ModuleHeader
				kicker={t("navigation:groups.gitIntegrations")}
				title={t("blastRadius:title")}
				description={t("blastRadius:description")}
				icon={Radar}
				tone="orange"
				actions={
					report && (
						<Chips>
							<Chip tone={SCORE_TONES[report.score]}>
								{t(`blastRadius:scoreLevels.${report.score}`)}
							</Chip>
						</Chips>
					)
				}
			/>

			<Columns template="minmax(0, 2fr) minmax(0, 3fr)">
				<Column
					kicker={t("blastRadius:kickers.targets")}
					title={t("blastRadius:targetsTitle")}
					tone="orange"
				>
					<Panel className="space-y-3">
						<div className="space-y-1.5">
							<label htmlFor="blast-radius-root" className="wp-kicker block">
								{t("blastRadius:projectRoot")}
							</label>
							<Input
								id="blast-radius-root"
								value={rootInput}
								onChange={(e) => setRootInput(e.target.value)}
								placeholder="/path/to/repo"
								className="font-mono text-xs"
							/>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="blast-radius-targets" className="wp-kicker block">
								{t("blastRadius:targets")}
							</label>
							<Textarea
								id="blast-radius-targets"
								className="min-h-[140px] font-mono text-xs"
								value={targetsInput}
								onChange={(e) => setTargetsInput(e.target.value)}
								placeholder="src/core/client.ts,src/utils/hash.ts"
							/>
						</div>
					</Panel>
				</Column>

				<Column
					kicker={t("blastRadius:kickers.impact")}
					title={t("blastRadius:impactTitle")}
					tone={report ? SCORE_TONES[report.score] : "muted"}
				>
					{error && (
						<Notice tone="red" icon={AlertTriangle} role="alert">
							{error}
						</Notice>
					)}
					{loading && <ScanLine label={t("blastRadius:analyzing")} />}
					{!loading && !report && !error && (
						<EmptyStage icon={Crosshair} title={t("blastRadius:emptyTitle")}>
							{t("blastRadius:emptyHint")}
						</EmptyStage>
					)}
					{report && !loading && (
						<div className="space-y-3">
							<Stats>
								<Stat
									label={t("blastRadius:score")}
									value={t(`blastRadius:scoreLevels.${report.score}`)}
									tone={SCORE_TONES[report.score]}
								/>
								<Stat
									label={t("blastRadius:dependents")}
									value={report.total_dependents}
								/>
								<Stat
									label={t("blastRadius:tests")}
									value={report.tests.length}
									tone="green"
								/>
							</Stats>

							{report.targets.length === 0 ? (
								<Notice tone="amber" icon={AlertTriangle}>
									{t("blastRadius:noValidTargets")}
								</Notice>
							) : (
								<Chips>
									{report.targets.map((target) => (
										<Chip key={target} tone={SCORE_TONES[report.score]} dot={false}>
											{target}
										</Chip>
									))}
								</Chips>
							)}

							{report.flags.length > 0 && (
								<Notice tone="amber" icon={AlertTriangle}>
									<span className="font-medium">{t("blastRadius:flags")}</span>
									<span className="mt-1 flex flex-wrap gap-1">
										{report.flags.map((flag) => (
											<code key={flag} className="wp-code px-1.5 py-0.5 text-xs">
												{flag}
											</code>
										))}
									</span>
								</Notice>
							)}

							{report.dependents.length > 0 && (
								<Panel className="space-y-2">
									<span className="wp-kicker">
										{t("blastRadius:dependentFiles")}
									</span>
									<div className="max-h-56 space-y-1 overflow-auto">
										{report.dependents.map((d) => (
											<div
												key={`${d.source}→${d.target}`}
												className="flex items-center gap-1 font-mono text-xs"
											>
												<code className="wp-muted">{d.source}</code>
												<span className="wp-muted" aria-hidden="true">
													→
												</span>
												<code>{d.target}</code>
											</div>
										))}
									</div>
								</Panel>
							)}

							{report.tests.length > 0 && (
								<Panel className="space-y-2">
									<span className="wp-kicker">{t("blastRadius:testFiles")}</span>
									<div className="max-h-44 space-y-0.5 overflow-auto">
										{report.tests.map((testFile) => (
											<code
												key={testFile}
												className="wp-muted flex items-center gap-1.5 font-mono text-xs"
											>
												<FileCode2 className="h-3 w-3 shrink-0" aria-hidden="true" />
												{testFile}
											</code>
										))}
									</div>
								</Panel>
							)}
						</div>
					)}
				</Column>
			</Columns>

			<Composer
				prompt={
					<span className="wp-muted truncate text-xs">
						{t("blastRadius:prompt")}
					</span>
				}
				actions={
					<CharterButton
						variant="primary"
						icon={Target}
						busy={loading}
						onClick={handleAnalyze}
						disabled={loading || !rootInput.trim() || !targetsInput.trim()}
					>
						{loading ? t("blastRadius:analyzing") : t("blastRadius:analyze")}
					</CharterButton>
				}
				hint={t("blastRadius:hint")}
			/>
		</ModuleStage>
	);
}
