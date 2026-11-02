import { useTranslation } from "react-i18next";
import type { SharedAnalysisReport } from "../../../preload/api/modules/shared-analysis-api";
import { formatAppDateTime } from "@/lib/date-format";

/** When the report shown was saved on the server, for a server project. */
export function SharedReportNote({
	saved,
}: {
	readonly saved: SharedAnalysisReport | null;
}): React.ReactElement | null {
	const { t } = useTranslation("common");
	if (!saved?.finishedAt) return null;
	const date = new Date(saved.finishedAt);
	if (Number.isNaN(date.getTime())) return null;
	return (
		<p className="text-xs text-(--text-secondary)">
			{t("sharedAnalysis.lastReport", { date: formatAppDateTime(date) })}
		</p>
	);
}
