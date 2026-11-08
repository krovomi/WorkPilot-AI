import { AlertCircle, FolderTree, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProjectIndex } from "../../../shared/types";
import { Badge } from "../ui/badge";
import {
	CharterButton,
	EmptyStage,
	Notice,
	ScanLine,
} from "../charter";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ScrollArea } from "../ui/scroll-area";
import { InfoItem } from "./InfoItem";
import { ServiceCard } from "./ServiceCard";

interface ProjectIndexTabProps {
	readonly projectIndex: ProjectIndex | null;
	readonly indexLoading: boolean;
	readonly indexError: string | null;
	readonly onRefresh: () => void;
}

export function ProjectIndexTab({
	projectIndex,
	indexLoading,
	indexError,
	onRefresh,
}: ProjectIndexTabProps) {
	const { t } = useTranslation(["context", "common"]);

	return (
		<ScrollArea className="h-full">
			<div className="mx-auto max-w-5xl space-y-5 px-5 pt-2 pb-6">
				<div className="flex items-center justify-between gap-3">
					<div>
						<span className="wp-kicker">
							{t("context:tabs.projectIndex")}
						</span>
						<h2 className="wp-title text-base">
							{t("context:projectIndex.title")}
						</h2>
					</div>
					<CharterButton
						size="sm"
						icon={RefreshCw}
						busy={indexLoading}
						onClick={onRefresh}
						disabled={indexLoading}
						title={t("context:projectIndex.refreshTooltip")}
					>
						{t("context:projectIndex.refresh")}
					</CharterButton>
				</div>

				{indexError && (
					<Notice tone="red" icon={AlertCircle} role="alert">
						<span className="font-medium">
							{t("context:projectIndex.errorTitle")}
						</span>
						<span className="mt-1 block text-xs">{indexError}</span>
					</Notice>
				)}

				{indexLoading && !projectIndex && (
					<ScanLine label={t("context:projectIndex.refresh")} />
				)}

				{!indexLoading && !projectIndex && !indexError && (
					<div className="flex justify-center py-8">
						<EmptyStage
							icon={FolderTree}
							title={t("context:projectIndex.noIndexTitle")}
							tone="blue"
							action={
								<CharterButton
									variant="primary"
									icon={RefreshCw}
									onClick={onRefresh}
								>
									{t("context:projectIndex.analyzeProject")}
								</CharterButton>
							}
						>
							{t("context:projectIndex.noIndexDescription")}
						</EmptyStage>
					</div>
				)}

				{/* Project index content */}
				{projectIndex && (
					<div className="space-y-6">
						{/* Project Overview */}
						<Card>
							<CardHeader className="pb-3">
								<CardTitle className="text-base">
									{t("common:labels.overview")}
								</CardTitle>
							</CardHeader>
							<CardContent className="space-y-3">
								<div className="flex items-center gap-2">
									<Badge variant="outline" className="capitalize">
										{projectIndex.project_type}
									</Badge>
									{Object.keys(projectIndex.services).length > 0 && (
										<Badge variant="secondary">
											{t("context:projectIndex.serviceCount", {
												count: Object.keys(projectIndex.services).length,
											})}
										</Badge>
									)}
								</div>
								<p className="text-sm text-muted-foreground font-mono truncate">
									{projectIndex.project_root}
								</p>
							</CardContent>
						</Card>

						{/* Services */}
						{Object.keys(projectIndex.services).length > 0 && (
							<div className="space-y-4">
								<h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
									{t("context:projectIndex.servicesHeading")}
								</h3>
								<div className="grid gap-4 md:grid-cols-2">
									{Object.entries(projectIndex.services).map(
										([name, service]) => (
											<ServiceCard key={name} name={name} service={service} />
										),
									)}
								</div>
							</div>
						)}

						{/* Infrastructure */}
						{Object.keys(projectIndex.infrastructure).length > 0 && (
							<div className="space-y-4">
								<h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
									{t("context:projectIndex.infrastructure")}
								</h3>
								<Card>
									<CardContent className="pt-6">
										<div className="grid gap-4 sm:grid-cols-2">
											{projectIndex.infrastructure.docker_compose && (
												<InfoItem
													label={t("context:infrastructure.dockerCompose")}
													value={projectIndex.infrastructure.docker_compose}
												/>
											)}
											{projectIndex.infrastructure.ci && (
												<InfoItem
													label={t("context:infrastructure.cicd")}
													value={projectIndex.infrastructure.ci}
												/>
											)}
											{projectIndex.infrastructure.deployment && (
												<InfoItem
													label={t("context:infrastructure.deployment")}
													value={projectIndex.infrastructure.deployment}
												/>
											)}
											{projectIndex.infrastructure.docker_services &&
												projectIndex.infrastructure.docker_services.length >
													0 && (
													<div className="sm:col-span-2">
														<span className="text-xs text-muted-foreground">
															{t("context:infrastructure.dockerServices")}
														</span>
														<div className="flex flex-wrap gap-1 mt-1">
															{projectIndex.infrastructure.docker_services.map(
																(svc) => (
																	<Badge
																		key={svc}
																		variant="secondary"
																		className="text-xs"
																	>
																		{svc}
																	</Badge>
																),
															)}
														</div>
													</div>
												)}
										</div>
									</CardContent>
								</Card>
							</div>
						)}

						{/* Conventions */}
						{Object.keys(projectIndex.conventions).length > 0 && (
							<div className="space-y-4">
								<h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
									{t("context:projectIndex.conventions")}
								</h3>
								<Card>
									<CardContent className="pt-6">
										<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
											{projectIndex.conventions.python_linting && (
												<InfoItem
													label={t("context:conventions.pythonLinting")}
													value={projectIndex.conventions.python_linting}
												/>
											)}
											{projectIndex.conventions.js_linting && (
												<InfoItem
													label={t("context:conventions.jsLinting")}
													value={projectIndex.conventions.js_linting}
												/>
											)}
											{projectIndex.conventions.formatting && (
												<InfoItem
													label={t("context:conventions.formatting")}
													value={projectIndex.conventions.formatting}
												/>
											)}
											{projectIndex.conventions.git_hooks && (
												<InfoItem
													label={t("context:conventions.gitHooks")}
													value={projectIndex.conventions.git_hooks}
												/>
											)}
											{projectIndex.conventions.typescript && (
												<InfoItem
													label={t("context:conventions.typescript")}
													value={t("context:conventions.enabled")}
												/>
											)}
										</div>
									</CardContent>
								</Card>
							</div>
						)}
					</div>
				)}
			</div>
		</ScrollArea>
	);
}
