/**
 * AI Pair Programming View (Feature 10), in the UI charter
 * (docs/architecture/ui-charter.md).
 *
 * Before a session: the three scopes as numbered steps, the start action in
 * the composer. During a session: your work, the coordination chat and the
 * AI's work side by side, the message box in the composer.
 */

import {
	AlertTriangle,
	CheckCircle2,
	ChevronRight,
	FileCode2,
	FilePlus,
	MessagesSquare,
	RotateCcw,
	Send,
	Square,
	Terminal as TerminalIcon,
	Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
	type AiAction,
	type PairMessage,
	type PairStatus,
	type StartSessionParams,
	sendPairMessage,
	startPairSession,
	stopPairSession,
	usePairProgrammingStore,
} from "@/stores/pair-programming-store";
import { GeneratedReviewBanner } from "./generated-review/GeneratedReviewBanner";
import {
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	StepCard,
	type Tone,
} from "./charter";

interface PairProgrammingProps {
	readonly projectId: string;
}

const STATUS_TONE: Record<PairStatus, Tone> = {
	idle: "muted",
	planning: "blue",
	active: "accent",
	paused: "amber",
	completed: "green",
	error: "red",
};

function StatusChip({ status }: { readonly status: PairStatus }) {
	const { t } = useTranslation("pairProgramming");
	return <Chip tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Chip>;
}

// ---------------------------------------------------------------------------
// Setup: the three scopes as steps, the start action in the composer
// ---------------------------------------------------------------------------

function SetupView({ onStart }: { readonly onStart: (params: StartSessionParams) => void }) {
	const { t } = useTranslation(["pairProgramming", "navigation"]);
	const [goal, setGoal] = useState("");
	const [devScope, setDevScope] = useState("");
	const [aiScope, setAiScope] = useState("");
	const ready = Boolean(goal.trim() && devScope.trim() && aiScope.trim());

	const start = () => {
		if (!ready) return;
		onStart({ projectId: "", goal: goal.trim(), devScope: devScope.trim(), aiScope: aiScope.trim() });
	};

	const fields = [
		{ key: "goal", tone: "accent", label: t("setup.goalLabel"), value: goal, set: setGoal, placeholder: t("setup.goalPlaceholder") },
		{ key: "you", tone: "blue", label: t("setup.devScopeLabel"), value: devScope, set: setDevScope, placeholder: t("setup.devScopePlaceholder") },
		{ key: "ai", tone: "violet", label: t("setup.aiScopeLabel"), value: aiScope, set: setAiScope, placeholder: t("setup.aiScopePlaceholder") },
	] as const;

	return (
		<ModuleStage data-testid="pair-programming-view">
			<ModuleHeader
				kicker={t("navigation:groups.development")}
				title={t("title")}
				description={t("empty.description")}
				icon={Users}
			/>
			<Columns template="minmax(260px, 30%) minmax(0, 1fr)">
				<Column kicker={t("steps.how")} title={t("subtitle")} tone="blue">
					<div className="flex flex-col gap-2">
						{(["feature1", "feature2", "feature3"] as const).map((f) => (
							<Panel key={f} className="flex items-start gap-2 text-sm">
								<ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
								{t(`empty.${f}`)}
							</Panel>
						))}
					</div>
				</Column>
				<Column kicker={t("startSession")} title={t("setup.title")}>
					<div className="flex flex-col gap-3">
						{fields.map((f, i) => (
							<StepCard key={f.key} index={i + 1} kicker={t(`steps.${f.key}`)} title={f.label} tone={f.tone}>
								<Textarea
									className="mt-1.5"
									value={f.value}
									onChange={(e) => f.set(e.target.value)}
									placeholder={f.placeholder}
									aria-label={f.label}
									rows={2}
								/>
							</StepCard>
						))}
					</div>
				</Column>
			</Columns>
			<Composer
				prompt={<span className="wp-muted truncate text-xs">{goal.trim() || t("setup.goalPlaceholder")}</span>}
				hint={t("setup.hint")}
				actions={
					<CharterButton variant="primary" icon={Users} disabled={!ready} onClick={start}>
						{t("setup.startButton")}
					</CharterButton>
				}
			/>
		</ModuleStage>
	);
}

// ---------------------------------------------------------------------------
// Action icon
// ---------------------------------------------------------------------------

function ActionIcon({ type }: { type: string }) {
	switch (type) {
		case "file_created":
			return <FilePlus className="w-3.5 h-3.5 text-success" />;
		case "file_modified":
			return <FileCode2 className="w-3.5 h-3.5 text-info" />;
		case "command_run":
			return <TerminalIcon className="w-3.5 h-3.5 text-warning" />;
		default:
			return <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />;
	}
}

// ---------------------------------------------------------------------------
// AI action log entry
// ---------------------------------------------------------------------------

function ActionEntry({ action }: { action: AiAction }) {
	const { t } = useTranslation("pairProgramming");
	const label = t(`actions.${action.actionType}`, {
		defaultValue: action.actionType,
	});
	return (
		<div className="flex items-start gap-2 border-b border-dashed border-border/60 py-1.5 last:border-0">
			<ActionIcon type={action.actionType} />
			<div className="min-w-0 flex-1">
				<span className="text-xs font-medium text-muted-foreground mr-1">
					{label}
				</span>
				{action.filePath && (
					<span className="text-xs font-mono text-foreground truncate block">
						{action.filePath}
					</span>
				)}
				{!action.filePath && (
					<span className="text-xs text-muted-foreground">
						{action.description}
					</span>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Chat message bubble
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: PairMessage }) {
	const { t } = useTranslation("pairProgramming");
	const isUser = message.role === "user";
	return (
		<div
			className={cn(
				"flex flex-col gap-0.5",
				isUser ? "items-end" : "items-start",
			)}
		>
			<span className="wp-kicker px-1">
				{isUser
					? t("chat.you")
					: message.isQuestion
						? t("chat.question")
						: t("chat.ai")}
			</span>
			<div
				className={cn(
					"rounded-xl px-3 py-2 max-w-[85%] text-sm",
					isUser
						? "bg-primary text-primary-foreground"
						: message.isQuestion
							? "bg-warning/10 border border-warning/30 text-foreground"
							: "wp-card text-foreground",
				)}
			>
				{message.content}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PairProgramming({ projectId }: PairProgrammingProps) {
	const { t } = useTranslation(["pairProgramming", "navigation"]);

	const session = usePairProgrammingStore((s) => s.session);
	const status = usePairProgrammingStore((s) => s.status);
	const statusMessage = usePairProgrammingStore((s) => s.statusMessage);
	const messages = usePairProgrammingStore((s) => s.messages);
	const pendingMessage = usePairProgrammingStore((s) => s.pendingMessage);
	const streamingContent = usePairProgrammingStore((s) => s.streamingContent);
	const aiActions = usePairProgrammingStore((s) => s.aiActions);
	const conflicts = usePairProgrammingStore((s) => s.conflicts);
	const review = usePairProgrammingStore((s) => s.review);
	const setPendingMessage = usePairProgrammingStore((s) => s.setPendingMessage);

	const chatEndRef = useRef<HTMLDivElement>(null);
	const streamEndRef = useRef<HTMLDivElement>(null);

	// Auto-scroll chat
	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	// Auto-scroll AI stream
	useEffect(() => {
		streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	const handleStart = (params: StartSessionParams) => {
		startPairSession({ ...params, projectId });
	};

	const handleStop = () => {
		if (session) stopPairSession(projectId, session.id);
	};

	const handleSendMessage = () => {
		if (!session || !pendingMessage.trim()) return;
		sendPairMessage(projectId, session.id, pendingMessage.trim());
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSendMessage();
		}
	};

	const isRunning = status === "planning" || status === "active";

	if (status === "idle" && !session) {
		return <SetupView onStart={handleStart} />;
	}

	return (
		<ModuleStage data-testid="pair-programming-view">
			<ModuleHeader
				kicker={t("navigation:groups.development")}
				title={session?.goal || t("title")}
				description={statusMessage || t("subtitle")}
				icon={Users}
				actions={
					<>
						{session && <StatusChip status={status} />}
						{isRunning && (
							<CharterButton size="sm" variant="danger" icon={Square} onClick={handleStop}>
								{t("stopSession")}
							</CharterButton>
						)}
						{(status === "completed" || status === "error") && (
							<CharterButton
								size="sm"
								icon={RotateCcw}
								onClick={() => usePairProgrammingStore.getState().reset()}
							>
								{t("newSession")}
							</CharterButton>
						)}
					</>
				}
			/>

			{conflicts.length > 0 && (
				<Notice tone="amber" icon={AlertTriangle} role="alert" className="relative z-[1] mx-5 mt-3">
					{t("conflicts.description")}{" "}
					<span className="wp-mono">{conflicts.map((c) => c.filePath).join(", ")}</span>
				</Notice>
			)}

			<Columns template="minmax(220px, 22%) minmax(0, 1fr) minmax(260px, 28%)">
				<Column kicker={t("steps.you")} title={t("sections.yourWork")} tone="blue">
					{session && (
						<div className="flex flex-col gap-3">
							<Panel rail tone="blue">
								<span className="wp-kicker">{t("devWork.scope")}</span>
								<p className="mt-1.5 text-sm leading-relaxed">{session.devScope}</p>
							</Panel>
							<Notice tone="muted">{t("devWork.reminder")}</Notice>
						</div>
					)}
				</Column>

				<Column kicker={t("chat.ai")} title={t("sections.chat")}>
					{messages.length === 0 ? (
						<EmptyStage icon={MessagesSquare} title={t("sections.chat")}>
							{t("chat.empty")}
						</EmptyStage>
					) : (
						<div className="flex flex-col gap-3">
							{messages.map((msg) => (
								<MessageBubble key={msg.id} message={msg} />
							))}
							<div ref={chatEndRef} />
						</div>
					)}
				</Column>

				<Column
					kicker={t("steps.ai")}
					title={t("sections.aiWork")}
					tone="violet"
					meta={status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : undefined}
				>
					<div className="flex flex-col gap-3">
						{session && (
							<Panel rail tone="violet">
								<p className="text-sm leading-relaxed">{session.aiScope}</p>
							</Panel>
						)}
						{review ? (
							<GeneratedReviewBanner key={review.taskId} review={review} projectId={projectId} />
						) : (
							session && <Notice tone="muted">{t("aiWork.reviewBranch")}</Notice>
						)}
						{isRunning && <ScanLine label={t(`aiWork.${status}`)} />}
						{streamingContent && (
							<pre className="wp-code max-h-48 overflow-y-auto">
								{streamingContent}
								{isRunning && <span className="animate-pulse">▌</span>}
								<span ref={streamEndRef} />
							</pre>
						)}
						<Panel>
							<span className="wp-kicker">{t("aiWork.actionLog")}</span>
							<div className="mt-1.5">
								{aiActions.length === 0 ? (
									<p className="wp-meta py-3 text-center">{t("aiWork.noActions")}</p>
								) : (
									aiActions.map((action) => <ActionEntry key={action.id} action={action} />)
								)}
							</div>
						</Panel>
					</div>
				</Column>
			</Columns>

			<Composer
				prompt={
					<Textarea
						value={pendingMessage}
						onChange={(e) => setPendingMessage(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={t("messagePlaceholder")}
						aria-label={t("messagePlaceholder")}
						rows={1}
						className="min-h-0 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
						disabled={!isRunning}
					/>
				}
				hint={t("setup.hint")}
				actions={
					<CharterButton
						variant="primary"
						icon={Send}
						onClick={handleSendMessage}
						disabled={!isRunning || !pendingMessage.trim()}
					>
						{t("sendMessage")}
					</CharterButton>
				}
			/>
		</ModuleStage>
	);
}
