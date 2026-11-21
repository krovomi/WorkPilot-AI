/**
 * Team links to a recorded agent session (#347): in the share dialog, leave
 * the masked session with a server project and get a link that expires; see
 * and revoke the project's links; and, beside Import, open a link a teammate
 * sent.
 *
 * The server keeps the session (`apps/backend/shared_features/
 * replay_shares.py`); only the project's members open a link, and the token
 * it holds is shown once, here, right after it is made.
 */

import { Link2, Users } from "lucide-react";
import type React from "react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { formatAppDateTime } from "@/lib/date-format";
import type { Project } from "../../../shared/types";
import {
	REPLAY_SHARE_TTL_DAYS,
	type ReplayTeamShare,
} from "../../../shared/types/replay-share";
import { useProjectStore } from "../../stores/project-store";
import { useReplayTeamShareStore } from "../../stores/replay-team-share-store";
import { Notice } from "../charter";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";

const WRITER_ROLES = new Set(["member", "owner"]);

/** The server projects where the person may leave a session. */
function writableServerProjects(projects: Project[]): Project[] {
	return projects.filter((p) => p.remote && WRITER_ROLES.has(p.remote.role));
}

const ShareRow: React.FC<{ share: ReplayTeamShare; onRevoke: () => void }> = ({
	share,
	onRevoke,
}) => {
	const { t } = useTranslation(["replay"]);
	return (
		<li className="rounded-md border border-[var(--wp-border)] p-2 text-sm">
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium break-words">{share.title}</span>
				<span className="text-xs text-muted-foreground">
					{t(`replay:share.team.state.${share.state}`)}
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				{t("replay:share.team.byLine", { by: share.createdBy, steps: share.steps })}
			</p>
			<p className="text-xs text-muted-foreground flex flex-wrap gap-x-3">
				<span>
					{t("replay:share.team.expires", { date: formatAppDateTime(share.expiresAt) })}
				</span>
				<span>{t("replay:share.team.opened", { count: share.openCount })}</span>
			</p>
			{share.canRevoke && share.state === "active" && (
				<Button variant="ghost" size="sm" className="px-0" onClick={onRevoke}>
					{t("replay:share.team.revoke")}
				</Button>
			)}
		</li>
	);
};

export const ReplayTeamShareSection: React.FC<{
	sessionId: string;
	options: { stripReasoning: boolean; stripTokens: boolean; includeFileContents: boolean };
}> = ({ sessionId, options }) => {
	const { t } = useTranslation(["replay"]);
	const projects = useProjectStore(useShallow((s) => writableServerProjects(s.projects)));
	const [chosen, setChosen] = useState<string | null>(null);
	const [ttlDays, setTtlDays] = useState(7);
	const [copied, setCopied] = useState(false);
	const idPrefix = useId();
	const { shares, loading, sharing, lastLink, error, loadShares, share, revoke, clear } =
		useReplayTeamShareStore(
			useShallow((s) => ({
				shares: s.shares,
				loading: s.loading,
				sharing: s.sharing,
				lastLink: s.lastLink,
				error: s.error,
				loadShares: s.loadShares,
				share: s.share,
				revoke: s.revoke,
				clear: s.clear,
			})),
		);
	const projectId =
		chosen && projects.some((p) => p.id === chosen) ? chosen : (projects[0]?.id ?? null);

	useEffect(() => {
		if (projectId) void loadShares(projectId);
	}, [projectId, loadShares]);

	// The link holds its token: closing the dialog forgets it.
	useEffect(() => clear, [clear]);

	if (!projectId) return null;
	const listed = shares[projectId] ?? [];
	const link = lastLink?.projectId === projectId ? lastLink.link : null;

	const create = async () => {
		setCopied(false);
		await share(sessionId, { projectId, ttlDays, ...options });
	};

	const copy = async (text: string) => {
		await navigator.clipboard.writeText(text);
		setCopied(true);
	};

	return (
		<section
			className="space-y-2 border-t border-[var(--wp-border)] pt-3"
			aria-label={t("replay:share.team.title")}
		>
			<h3 className="text-sm font-semibold flex items-center gap-1">
				<Users className="h-4 w-4" />
				{t("replay:share.team.title")}
			</h3>
			<p className="text-xs text-muted-foreground">{t("replay:share.team.hint")}</p>
			<div className="flex flex-wrap items-end gap-2">
				<div className="space-y-1">
					<Label htmlFor={`${idPrefix}-project`}>{t("replay:share.team.project")}</Label>
					<NativeSelect
						id={`${idPrefix}-project`}
						value={projectId}
						onChange={(e) => setChosen(e.target.value)}
					>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</NativeSelect>
				</div>
				<div className="space-y-1">
					<Label htmlFor={`${idPrefix}-ttl`}>{t("replay:share.team.ttl")}</Label>
					<NativeSelect
						id={`${idPrefix}-ttl`}
						value={String(ttlDays)}
						onChange={(e) => setTtlDays(Number(e.target.value))}
					>
						{REPLAY_SHARE_TTL_DAYS.map((days) => (
							<option key={days} value={String(days)}>
								{t(`replay:share.team.ttlOptions.${days}`)}
							</option>
						))}
					</NativeSelect>
				</div>
				<Button disabled={sharing} onClick={create}>
					<Link2 className="h-4 w-4 mr-1" />
					{t(sharing ? "replay:share.team.creating" : "replay:share.team.create")}
				</Button>
			</div>
			{error && (
				<Notice tone="red" role="alert">
					<span>{t(error.key, error.values)}</span>
				</Notice>
			)}
			{link && (
				<div className="space-y-1">
					<Label htmlFor={`${idPrefix}-link`}>{t("replay:share.team.link")}</Label>
					<div className="flex gap-2">
						<Input id={`${idPrefix}-link`} readOnly value={link} />
						<Button variant="outline" onClick={() => copy(link)}>
							{t(copied ? "replay:share.team.copied" : "replay:share.team.copy")}
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						{t("replay:share.team.linkOnce")}
					</p>
				</div>
			)}
			<h4 className="text-xs font-semibold">{t("replay:share.team.listTitle")}</h4>
			{loading && listed.length === 0 ? (
				<p className="text-xs text-muted-foreground">{t("replay:share.team.loading")}</p>
			) : listed.length === 0 ? (
				<p className="text-xs text-muted-foreground">{t("replay:share.team.empty")}</p>
			) : (
				<ul className="space-y-2 max-h-48 overflow-y-auto">
					{listed.map((item) => (
						<ShareRow
							key={item.id}
							share={item}
							onRevoke={() => revoke(projectId, item.id)}
						/>
					))}
				</ul>
			)}
		</section>
	);
};

export const ReplayOpenLinkButton: React.FC = () => {
	const { t } = useTranslation(["replay"]);
	const [open, setOpen] = useState(false);
	const [link, setLink] = useState("");
	const idPrefix = useId();
	const { opening, openLink } = useReplayTeamShareStore(
		useShallow((s) => ({ opening: s.opening, openLink: s.openLink })),
	);
	const hasServerProject = useProjectStore((s) => s.projects.some((p) => !!p.remote));
	if (!hasServerProject) return null;

	const submit = async () => {
		const opened = await openLink(link);
		setOpen(false);
		if (opened) setLink("");
	};

	return (
		<>
			<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
				<Link2 className="h-4 w-4 mr-1" />
				{t("replay:share.open.button")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("replay:share.open.title")}</DialogTitle>
						<DialogDescription>{t("replay:share.open.description")}</DialogDescription>
					</DialogHeader>
					<Label htmlFor={`${idPrefix}-link`}>{t("replay:share.open.label")}</Label>
					<Input
						id={`${idPrefix}-link`}
						value={link}
						maxLength={512}
						onChange={(e) => setLink(e.target.value)}
					/>
					<div className="flex justify-end pt-2">
						<Button disabled={opening || !link.trim()} onClick={submit}>
							{t(opening ? "replay:share.open.opening" : "replay:share.open.submit")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
};
