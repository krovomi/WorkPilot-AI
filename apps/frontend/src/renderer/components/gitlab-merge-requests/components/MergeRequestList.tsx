import { GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { GitLabMergeRequest } from "../../../../shared/types";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ScrollArea } from "../../ui/scroll-area";
import { MergeRequestItem } from "./MergeRequestItem";
import { useTranslation } from "react-i18next";

interface MergeRequestListProps {
	mergeRequests: GitLabMergeRequest[];
	isLoading: boolean;
	selectedMrIid: number | null;
	onSelectMr: (mr: GitLabMergeRequest) => void;
	onRefresh: () => void;
	stateFilter: "opened" | "closed" | "merged" | "all";
	onStateFilterChange: (state: "opened" | "closed" | "merged" | "all") => void;
}

export function MergeRequestList({
	mergeRequests,
	isLoading,
	selectedMrIid,
	onSelectMr,
	onRefresh,
	stateFilter,
	onStateFilterChange,
}: MergeRequestListProps) {
	const { t } = useTranslation();
	const [searchQuery, setSearchQuery] = useState("");

	const query = searchQuery.trim().toLowerCase();
	const filteredMrs = mergeRequests.filter((mr) =>
		[mr.title, mr.sourceBranch, mr.targetBranch, `!${mr.iid}`].some((field) =>
			field.toLowerCase().includes(query),
		),
	);

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="p-4 border-b border-border space-y-3">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-medium text-foreground flex items-center gap-2">
						<GitPullRequest className="h-4 w-4" />
						{t("gitlab:mergeRequests.listTitle")}
					</h3>
					<Button
						variant="ghost"
						size="sm"
						onClick={onRefresh}
						disabled={isLoading}
						aria-label={t("common:accessibility.refreshAriaLabel")}
						className="h-7 px-2"
					>
						<RefreshCw
							className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`}
						/>
					</Button>
				</div>

				<Input
					placeholder={t("gitlab:mergeRequests.searchPlaceholder")}
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="h-8 text-sm"
				/>

				<div className="flex gap-1">
					{(["opened", "merged", "closed", "all"] as const).map((state) => (
						<Button
							key={state}
							variant={stateFilter === state ? "default" : "ghost"}
							size="sm"
							onClick={() => onStateFilterChange(state)}
							aria-pressed={stateFilter === state}
							className="h-7 text-xs"
						>
							{t(`gitlab:mergeRequests.filters.${state}`)}
						</Button>
					))}
				</div>
			</div>

			{/* List */}
			<ScrollArea className="flex-1">
				{isLoading && mergeRequests.length === 0 ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				) : filteredMrs.length === 0 ? (
					<div className="py-8 text-center text-sm text-muted-foreground">
						{searchQuery
							? t("gitlab:mergeRequests.noMatch")
							: t("gitlab:mergeRequests.empty")}
					</div>
				) : (
					<div className="p-2 space-y-1">
						{filteredMrs.map((mr) => (
							<MergeRequestItem
								key={mr.id}
								mr={mr}
								isSelected={mr.iid === selectedMrIid}
								onClick={() => onSelectMr(mr)}
							/>
						))}
					</div>
				)}
			</ScrollArea>
		</div>
	);
}
