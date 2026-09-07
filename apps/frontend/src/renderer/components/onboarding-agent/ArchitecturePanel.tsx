import { FolderTree } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import { Badge } from "../ui/badge";
import { EmptyState } from "./shared";

export function ArchitecturePanel(): React.ReactElement | null {
	const { t } = useTranslation("onboardingAgent");
	const pkg = useOnboardingAgentStore((s) => s.pkg);

	if (!pkg) return null;

	const nodes = pkg.guide.architecture ?? [];
	if (nodes.length === 0) {
		return <EmptyState message={t("emptyArchitecture")} />;
	}

	const largest = Math.max(...nodes.map((node) => node.file_count));

	return (
		<div className="space-y-2">
			<p className="text-sm text-muted-foreground">{t("architectureIntro")}</p>
			{nodes.map((node) => {
				const depth = node.path.split("/").length - 1;
				return (
					<div
						key={node.path}
						className="border rounded-md p-3 bg-card"
						style={{ marginLeft: `${depth * 16}px` }}
					>
						<div className="flex items-center justify-between gap-3">
							<p className="text-sm font-mono flex items-center gap-2 min-w-0">
								<FolderTree className="w-4 h-4 shrink-0 text-muted-foreground" />
								<span className="truncate">{node.path}/</span>
							</p>
							<span className="text-xs text-muted-foreground whitespace-nowrap">
								{t("architectureFiles", { count: node.file_count })}
							</span>
						</div>
						<p className="text-sm text-muted-foreground mt-1">{node.role}</p>
						<div className="flex items-center gap-2 mt-2">
							<div className="h-1.5 bg-muted rounded-full flex-1 overflow-hidden">
								<div
									className="h-full bg-primary/60"
									style={{
										width: `${Math.max(2, Math.round((node.file_count / largest) * 100))}%`,
									}}
								/>
							</div>
							{node.languages.map((language) => (
								<Badge key={language} variant="muted">
									{language}
								</Badge>
							))}
						</div>
					</div>
				);
			})}
		</div>
	);
}
