import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import "./diff-viewer.css";

const BLOCKS = 5;

/**
 * GitHub's diffstat squares: `BLOCKS` squares shared between additions (green)
 * and deletions (red) by their weight; a side with changes gets at least one.
 */
export function diffStatBlocks(
	additions: number,
	deletions: number,
): Array<"add" | "del" | "none"> {
	const total = additions + deletions;
	let add = total === 0 ? 0 : Math.round((additions / total) * BLOCKS);
	if (additions > 0 && add === 0) add = 1;
	if (deletions > 0 && add === BLOCKS) add = BLOCKS - 1;
	const del = total === 0 ? 0 : BLOCKS - add;
	return Array.from({ length: BLOCKS }, (_, k) =>
		k < add ? "add" : k < add + del ? "del" : "none",
	);
}

const BLOCK_IDS = Array.from({ length: BLOCKS }, (_, k) => `block-${k}`);

interface DiffStatProps {
	readonly additions: number;
	readonly deletions: number;
	/** Hide the squares (tight rows). */
	readonly compact?: boolean;
	readonly className?: string;
}

/** `+12 -3 ■■■■□` in git colours, readable in every theme. */
export function DiffStat({
	additions,
	deletions,
	compact,
	className,
}: DiffStatProps) {
	const { t } = useTranslation(["common"]);
	return (
		<span
			className={cn("dv-stat", className)}
			title={t("common:diffViewer.stat", { additions, deletions })}
		>
			<span className="dv-stat-add">+{additions}</span>
			<span className="dv-stat-del">-{deletions}</span>
			{!compact && (
				<span className="dv-stat-bar" aria-hidden="true">
					{diffStatBlocks(additions, deletions).map((kind, k) => (
						<i key={BLOCK_IDS[k]} className={kind} />
					))}
				</span>
			)}
		</span>
	);
}
