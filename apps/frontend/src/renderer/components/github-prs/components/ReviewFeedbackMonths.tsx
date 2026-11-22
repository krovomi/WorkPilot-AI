/**
 * The panel's figures by month (#361, lot 4): the PRs reviewed, the findings
 * per PR, and the kinds of remark the reviewer learned. The main process
 * computes them, on the machine or from the team's server; nothing here is
 * computed but the average, and nothing is sent anywhere.
 */

import { useTranslation } from "react-i18next";
import type { ReviewFeedbackMonth } from "../../../../shared/types/review-feedback";

function perPr(row: ReviewFeedbackMonth, language: string): string {
	if (row.reviews === 0) return "—";
	return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(
		row.findings / row.reviews,
	);
}

export function ReviewFeedbackMonths({ rows }: { rows: ReviewFeedbackMonth[] }) {
	const { t, i18n } = useTranslation("reviewFeedback");
	if (rows.length === 0) return null;
	return (
		<div className="space-y-1">
			<table className="w-full text-xs">
				<caption className="text-left font-medium text-foreground pb-1">
					{t("months.title")}
				</caption>
				<thead>
					<tr className="text-muted-foreground">
						<th scope="col" className="text-left font-normal py-1">
							{t("months.month")}
						</th>
						<th scope="col" className="text-right font-normal">
							{t("months.reviews")}
						</th>
						<th scope="col" className="text-right font-normal">
							{t("months.findingsPerPr")}
						</th>
						<th scope="col" className="text-right font-normal">
							{t("months.rulesLearned")}
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.month} className="border-t border-border/50">
							<td className="py-1">
								<code>{row.month}</code>
							</td>
							<td className="text-right">{row.reviews}</td>
							<td className="text-right">{perPr(row, i18n.language)}</td>
							<td className="text-right">{row.rulesLearned}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p>{t("months.hint")}</p>
		</div>
	);
}
