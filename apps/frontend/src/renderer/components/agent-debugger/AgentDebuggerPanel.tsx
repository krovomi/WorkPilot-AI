import { Bug, Check, ChevronRight, Pause, Plus, RefreshCw, Trash2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentDebuggerStore } from "../../stores/agent-debugger-store";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	Section,
	StepCard,
} from "../charter";
import { Input } from "../ui/input";

const TOOLS = ["*", "Write", "Edit", "Bash"] as const;

interface Props {
	readonly sessionId?: string;
}

/** Breakpoints on an agent's tool calls, and the frames they paused. */
export function AgentDebuggerPanel({ sessionId }: Props) {
	const { t } = useTranslation(["agentDebugger", "common", "navigation"]);
	const {
		sessionId: attachedSession,
		sessions,
		breakpoints,
		frames,
		loading,
		error,
		listSessions,
		attach,
		detach,
		addBreakpoint,
		removeBreakpoint,
		resume,
		refresh,
	} = useAgentDebuggerStore();

	const [newId, setNewId] = useState("");
	const [newTool, setNewTool] = useState<(typeof TOOLS)[number]>("*");
	const [newPattern, setNewPattern] = useState("");

	// A session passed in by the parent view is attached straight away.
	useEffect(() => {
		if (sessionId && !attachedSession) void attach(sessionId);
	}, [sessionId, attachedSession, attach]);

	// Poll while the panel is open so paused frames (produced by a live agent
	// run in another process) show up without a manual refresh, and so live
	// runs appear in the list as they start. Gentle intervals: each tick
	// spawns a one-shot runner process.
	useEffect(() => {
		if (attachedSession) {
			const id = setInterval(() => void refresh(), 2000);
			return () => clearInterval(id);
		}
		void listSessions();
		const id = setInterval(() => void listSessions(), 4000);
		return () => clearInterval(id);
	}, [attachedSession, refresh, listSessions]);

	const isBash = newTool === "Bash";

	const handleAdd = async () => {
		const id = newId.trim();
		if (!id) return;
		const pattern = newPattern.trim() || undefined;
		await addBreakpoint({
			id,
			tool: newTool,
			path_pattern: isBash ? undefined : pattern,
			command_pattern: isBash ? pattern : undefined,
			enabled: true,
		});
		setNewId("");
		setNewPattern("");
	};

	const sortedSessions = [...sessions].sort((a, b) => Number(b.active ?? false) - Number(a.active ?? false));

	return (
		<ModuleStage scroll="page" data-testid="agent-debugger-view">
			<ModuleHeader
				kicker={t("navigation:groups.workspace")}
				title={t("agentDebugger:title")}
				description={t("agentDebugger:description")}
				icon={Bug}
				tone="red"
				actions={
					attachedSession ? (
						<>
							<CharterButton icon={RefreshCw} onClick={() => void refresh()}>
								{t("common:buttons.refresh")}
							</CharterButton>
							<CharterButton icon={Unplug} onClick={() => void detach()}>
								{t("agentDebugger:detach")}
							</CharterButton>
						</>
					) : (
						<CharterButton icon={RefreshCw} onClick={() => void listSessions()}>
							{t("common:buttons.refresh")}
						</CharterButton>
					)
				}
			/>
			<Page className="space-y-4">
				{error && (
					<Notice tone="red" role="alert">
						{error}
					</Notice>
				)}

				{!attachedSession && (
					<Section
						kicker={t("agentDebugger:kickers.sessions")}
						title={t("agentDebugger:attachTitle")}
						description={t("agentDebugger:attachHint")}
					>
						{sortedSessions.length === 0 ? (
							<EmptyStage icon={Bug} tone="red" title={t("agentDebugger:noSessions")}>
								{t("agentDebugger:noSessionsHint")}
							</EmptyStage>
						) : (
							<div className="grid gap-2.5 lg:grid-cols-2">
								{sortedSessions.map((s) => (
									<StepCard
										key={s.session_id}
										kicker={s.active ? t("agentDebugger:live") : t("agentDebugger:lastRun")}
										title={s.session_id}
										tone={s.active ? "green" : "muted"}
										meta={[
											s.meta?.agent_type,
											t("agentDebugger:sessionMeta", { bp: s.breakpoints ?? 0, frames: s.frames ?? 0 }),
										]
											.filter(Boolean)
											.join(" · ")}
										onClick={loading ? undefined : () => void attach(s.session_id)}
									/>
								))}
							</div>
						)}
					</Section>
				)}

				{attachedSession && (
					<>
						<Notice tone="green" icon={Bug}>
							{t("agentDebugger:attachedTo")} <span className="font-mono">{attachedSession}</span>
						</Notice>

						<Section
							kicker={t("agentDebugger:kickers.breakpoints")}
							title={t("agentDebugger:breakpoints")}
							meta={String(breakpoints.length)}
						>
							<Panel className="space-y-3">
								<div className="grid gap-3 md:grid-cols-[1fr_auto]">
									<div className="space-y-1.5">
										<label htmlFor="debugger-rule-id" className="wp-kicker block">
											{t("agentDebugger:ruleId")}
										</label>
										<Input
											id="debugger-rule-id"
											value={newId}
											onChange={(e) => setNewId(e.target.value)}
											placeholder={t("agentDebugger:placeholders.ruleId")}
											className="font-mono text-xs"
										/>
									</div>
									<div className="space-y-1.5">
										<span className="wp-kicker block">{t("agentDebugger:tool")}</span>
										<div className="wp-chips">
											{TOOLS.map((tool) => (
												<Chip
													key={tool}
													tone="red"
													pressed={newTool === tool}
													onClick={() => setNewTool(tool)}
												>
													{tool === "*" ? t("agentDebugger:anyTool") : tool}
												</Chip>
											))}
										</div>
									</div>
								</div>
								<div className="flex items-end gap-2">
									<div className="flex-1 space-y-1.5">
										<label htmlFor="debugger-pattern" className="wp-kicker block">
											{isBash ? t("agentDebugger:commandPattern") : t("agentDebugger:pathPattern")}
										</label>
										<Input
											id="debugger-pattern"
											value={newPattern}
											onChange={(e) => setNewPattern(e.target.value)}
											placeholder={
												isBash
													? t("agentDebugger:placeholders.command")
													: t("agentDebugger:placeholders.path")
											}
											className="font-mono text-xs"
										/>
									</div>
									<CharterButton
										variant="primary"
										icon={Plus}
										onClick={() => void handleAdd()}
										disabled={!newId.trim()}
									>
										{t("common:buttons.add")}
									</CharterButton>
								</div>
							</Panel>

							<div className="mt-3 space-y-2">
								{breakpoints.length === 0 ? (
									<p className="wp-meta">{t("agentDebugger:noBreakpoints")}</p>
								) : (
									breakpoints.map((bp) => (
										<Panel key={bp.id} rail tone="red" className="flex items-center gap-2">
											<span className="wp-title min-w-0 truncate font-mono text-sm">{bp.id}</span>
											<Chip tone="muted" dot={false}>
												{bp.tool === "*" ? t("agentDebugger:anyTool") : bp.tool}
											</Chip>
											{bp.path_pattern && (
												<Chip tone="blue" dot={false}>
													{t("agentDebugger:pathPattern")}: {bp.path_pattern}
												</Chip>
											)}
											{bp.command_pattern && (
												<Chip tone="amber" dot={false}>
													{t("agentDebugger:commandPattern")}: {bp.command_pattern}
												</Chip>
											)}
											<span className="flex-1" />
											<CharterButton
												size="sm"
												variant="ghost"
												icon={Trash2}
												aria-label={t("agentDebugger:remove")}
												onClick={() => void removeBreakpoint(bp.id)}
											/>
										</Panel>
									))
								)}
							</div>
						</Section>

						<Section
							kicker={t("agentDebugger:kickers.frames")}
							title={t("agentDebugger:pausedFrames")}
							meta={String(frames.length)}
						>
							{frames.length === 0 ? (
								<EmptyStage icon={Pause} tone="amber" title={t("agentDebugger:noFrames")}>
									{t("agentDebugger:noFramesHint")}
								</EmptyStage>
							) : (
								<div className="space-y-2.5">
									{frames.map((f) => (
										<Panel key={f.frame_id} rail tone="amber" className="space-y-2">
											<div className="flex flex-wrap items-center gap-2">
												<span className="wp-title text-sm">{f.tool_name}</span>
												<Chip tone="red">{f.breakpoint_id}</Chip>
											</div>
											<pre className="wp-code max-h-64 overflow-auto whitespace-pre-wrap">
												{JSON.stringify(f.tool_input, null, 2)}
											</pre>
											<div className="flex gap-2">
												<CharterButton
													size="sm"
													variant="primary"
													icon={Check}
													onClick={() => void resume(f.frame_id, "continue")}
												>
													{t("agentDebugger:continue")}
												</CharterButton>
												<CharterButton
													size="sm"
													icon={ChevronRight}
													onClick={() => void resume(f.frame_id, "skip", { reason: "skipped" })}
												>
													{t("agentDebugger:skip")}
												</CharterButton>
											</div>
										</Panel>
									))}
								</div>
							)}
						</Section>
					</>
				)}
			</Page>
		</ModuleStage>
	);
}
