/**
 * What the static scan found in the code a catalog server runs (issue #369,
 * lot 3): each rule with the file and line of its first match, a finding the
 * project's MCP policy accepts shown with its reason. The file names come
 * from the package's archive: shown as text, never opened.
 */

import { useTranslation } from "react-i18next";
import type { McpCodeReport } from "../../../shared/types/mcp-code-scan";
import { cn } from "../../lib/utils";

const RISKY = new Set(["shellExec", "dynamicCode", "hardcodedSecret"]);

export function McpCodeScanDetails({ report }: { readonly report: McpCodeReport }) {
	const { t } = useTranslation(["common"]);
	if (report.reason) return null;
	return (
		<div className="space-y-0.5" data-testid="mcp-code-scan">
			<p className="font-medium text-foreground">
				{t("mcpMarketplace.security.code.title", {
					version: report.version,
					files: report.files ?? 0,
				})}
			</p>
			{(report.skipped ?? 0) > 0 && (
				<p>{t("mcpMarketplace.security.code.partial", { count: report.skipped })}</p>
			)}
			{report.findings.length === 0 ? (
				<p>{t("mcpMarketplace.security.code.none")}</p>
			) : (
				<ul className="space-y-0.5">
					{report.findings.map((finding) => (
						<li key={`${finding.rule}-${finding.file}`} className="flex flex-wrap gap-1">
							<span
								className={cn(
									"font-medium",
									finding.accepted
										? "text-muted-foreground"
										: RISKY.has(finding.rule)
											? "text-warning"
											: "text-foreground",
								)}
							>
								{t(`mcpMarketplace.security.code.rules.${finding.rule}`)}
							</span>
							<code className="break-all">
								{finding.file}:{finding.line}
							</code>
							{finding.count > 1 && (
								<span>{t("mcpMarketplace.security.code.more", { count: finding.count - 1 })}</span>
							)}
							{finding.accepted && (
								<span className="italic">
									{t("mcpMarketplace.security.code.accepted", { reason: finding.accepted })}
								</span>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
