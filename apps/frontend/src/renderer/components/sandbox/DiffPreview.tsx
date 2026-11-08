import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DiffHunk, FileDiff } from "../../../shared/types/sandbox";
import { Chip, Column, Columns, Panel, StepCard, type Tone } from "../charter";

const CHANGE_TONES: Record<FileDiff["changeType"], Tone> = {
	added: "green",
	modified: "blue",
	deleted: "red",
	renamed: "violet",
};

interface DiffPreviewProps {
	readonly diffs: readonly FileDiff[];
	/** Shown above the file list (stats, steps of a run). */
	readonly aside?: React.ReactNode;
}

/** Changed files on the left, the selected file's hunks on the right. */
export function DiffPreview({ diffs, aside }: DiffPreviewProps): React.ReactElement {
	const { t } = useTranslation("sandbox");
	const [selected, setSelected] = useState<string | null>(diffs[0]?.filePath ?? null);
	const active = diffs.find((d) => d.filePath === selected) ?? diffs[0];
	const additions = diffs.reduce((sum, d) => sum + d.additions, 0);
	const deletions = diffs.reduce((sum, d) => sum + d.deletions, 0);

	return (
		<Columns template="minmax(0, 1fr) minmax(0, 2.4fr)">
			<Column
				kicker={t("kickers.files")}
				title={t("diffPreview.filesChanged", { count: diffs.length })}
				meta={`+${additions} −${deletions}`}
				tone="violet"
			>
				{aside}
				<div className="grid gap-2">
					{diffs.map((diff) => (
						<StepCard
							key={diff.filePath}
							kicker={t(`changeTypes.${diff.changeType}`)}
							title={<span className="break-all font-mono text-xs">{diff.filePath}</span>}
							meta={`+${diff.additions} −${diff.deletions}`}
							tone={CHANGE_TONES[diff.changeType] ?? "muted"}
							active={diff.filePath === active?.filePath}
							onClick={() => setSelected(diff.filePath)}
						/>
					))}
				</div>
			</Column>
			<Column
				kicker={t("kickers.diff")}
				title={<span className="font-mono text-sm">{active?.filePath ?? t("diffPreview.selectFile")}</span>}
				meta={
					active ? (
						<Chip tone={CHANGE_TONES[active.changeType] ?? "muted"}>{t(`changeTypes.${active.changeType}`)}</Chip>
					) : undefined
				}
			>
				<div className="grid gap-2.5">
					{active?.hunks.map((hunk) => (
						<Hunk key={`${hunk.oldStart}-${hunk.oldCount}-${hunk.newStart}-${hunk.newCount}`} hunk={hunk} />
					))}
					{active && active.hunks.length === 0 && <p className="wp-muted text-sm">{t("diffPreview.noHunks")}</p>}
				</div>
			</Column>
		</Columns>
	);
}

function Hunk({ hunk }: { readonly hunk: DiffHunk }): React.ReactElement {
	const rows = hunk.content.split("\n").map((text, i) => ({ id: `${hunk.newStart}:${i}`, text }));
	return (
		<Panel padded={false} className="overflow-hidden">
			<div className="wp-meta border-b border-[var(--wp-border)] px-3 py-1 font-mono">
				@@ −{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
			</div>
			<pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5">
				{rows.map((row) => (
					<div
						key={row.id}
						className={
							row.text.startsWith("+")
								? "wp-tone-green wp-ink"
								: row.text.startsWith("-")
									? "wp-tone-red wp-ink"
									: "wp-muted"
						}
					>
						{row.text || " "}
					</div>
				))}
			</pre>
		</Panel>
	);
}
