/**
 * #3.5 Pair Programming panel.
 *
 * A room on the open project: people chat, the room points at one file of the
 * project, and an AI participant can be invited. When it is in the room, each
 * message gets its turn: the main process sends the room's chat and that file
 * to the provider chosen for this page (Fonctions avancées) and posts the
 * answer as the AI, with any proposed code as a suggestion (shown, never
 * written). See `main/pair-ai-partner.ts`.
 *
 * The room lives on this computer's backend: the panel says so, since nobody
 * else can join it from here.
 */

import { Bot, FileText, FolderOpen, Info, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { PairRoomSnapshot } from "../../../preload/api/modules/phase35-features-api";
import { PAIR_AI_USER_ID, usePairRealtimeStore } from "../../stores/phase35-stores";
import { Notice } from "../charter";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { PanelShell } from "./_panel-shell";
import { relativeToProject } from "./_relative-to-project";

const ROLES = [
	{ value: "driver", labelKey: "pair.roleDriver" },
	{ value: "navigator", labelKey: "pair.roleNavigator" },
] as const;
const ROLE_KEYS: Record<PairRoomSnapshot["participants"][number]["role"], string> = {
	driver: "pair.roleDriver",
	navigator: "pair.roleNavigator",
	ai: "pair.roleAi",
};
const AI_ERRORS = ["room", "unavailable", "empty", "invalid"] as const;

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX_LEN = 64;
const MESSAGE_MAX_LEN = 2000;
const PATH_MAX_LEN = 1024;

type Role = (typeof ROLES)[number]["value"];

const text = (value: unknown): string => (typeof value === "string" ? value : "");

interface PairProgrammingPanelProps {
	readonly projectPath?: string;
}

export function PairProgrammingPanel({ projectPath = "" }: PairProgrammingPanelProps) {
	const { t } = useTranslation("phase35");
	const {
		phase,
		error,
		currentRoom,
		ops,
		isStreaming,
		aiThinking,
		aiError,
		createOrJoin,
		leave,
		sendChat,
		inviteAi,
		focusFile,
		subscribe,
	} = usePairRealtimeStore(
		useShallow((s) => ({
			phase: s.phase,
			error: s.error,
			currentRoom: s.currentRoom,
			ops: s.ops,
			isStreaming: s.isStreaming,
			aiThinking: s.aiThinking,
			aiError: s.aiError,
			createOrJoin: s.createOrJoin,
			leave: s.leave,
			sendChat: s.sendChat,
			inviteAi: s.inviteAi,
			focusFile: s.focusFile,
			subscribe: s.subscribe,
		})),
	);
	const [roomId, setRoomId] = useState("pair");
	const [displayName, setDisplayName] = useState("");
	const [role, setRole] = useState<Role>("driver");
	const [chatText, setChatText] = useState("");
	const [pickFailed, setPickFailed] = useState(false);
	const [fileInput, setFileInput] = useState("");
	const opsScrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (currentRoom && !isStreaming) void subscribe();
	}, [currentRoom, isStreaming, subscribe]);

	// Keep the newest operation in view as the room moves.
	useEffect(() => {
		const el = opsScrollRef.current;
		if (el && ops.length > 0) el.scrollTop = el.scrollHeight;
	}, [ops.length]);

	const roomIdError = useMemo(() => {
		const trimmed = roomId.trim();
		if (trimmed.length === 0) return t("pair.validation.roomIdRequired");
		if (!ROOM_ID_PATTERN.test(trimmed)) return t("pair.validation.roomIdInvalid");
		return null;
	}, [roomId, t]);
	const nameError = displayName.trim().length === 0 ? t("pair.validation.nameRequired") : null;
	const canJoin = Boolean(projectPath) && !roomIdError && !nameError;

	const names = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of currentRoom?.participants ?? []) map.set(p.user_id, p.display_name);
		return map;
	}, [currentRoom]);
	const nameOf = (actor: string) => names.get(actor) ?? actor;
	const aiPresent = names.has(PAIR_AI_USER_ID);

	const focusedFile = useMemo(() => {
		for (let i = ops.length - 1; i >= 0; i--) {
			const op = ops[i];
			if (op.kind === "cursor" || op.kind === "edit") return text(op.payload.file_path);
		}
		return "";
	}, [ops]);

	if (!projectPath) {
		return (
			<PanelShell title={t("pair.title")} subtitle={t("pair.subtitle")}>
				<p className="text-sm text-muted-foreground">{t("common.projectPathRequired")}</p>
			</PanelShell>
		);
	}

	const handleJoin = () => {
		const name = displayName.trim();
		// A name with no Latin letter or digit used to become the id "-".
		const slug = name
			.toLowerCase()
			.replaceAll(/[^a-z0-9_-]+/g, "-")
			.replaceAll(/^-+|-+$/g, "")
			.slice(0, 64);
		const userId = slug || "me";
		void createOrJoin(roomId.trim(), userId, name, role, projectPath);
	};

	// Send is disabled while the box is blank, which also blocks Enter; the box
	// cuts a message at MESSAGE_MAX_LEN as it is typed.
	const handleSubmitChat = (e: React.FormEvent) => {
		e.preventDefault();
		setChatText("");
		void sendChat(chatText.trim());
	};

	const handleFocus = (raw: string) => {
		const rel = relativeToProject(raw.trim(), projectPath).slice(0, PATH_MAX_LEN);
		if (!rel) return;
		void focusFile(rel);
		setFileInput("");
	};

	const handlePickFile = async () => {
		setPickFailed(false);
		try {
			// A cancelled dialog answers an empty list: the room keeps its file.
			const picked = await globalThis.electronAPI.selectFiles({
				multi: false,
				title: t("pair.pickFile"),
				defaultPath: projectPath,
			});
			if (picked.length > 0) handleFocus(picked[0]);
		} catch {
			setPickFailed(true);
		}
	};

	const aiErrorText =
		aiError && (AI_ERRORS as readonly string[]).includes(aiError)
			? t(`pair.aiErrors.${aiError}` as never)
			: null;

	return (
		<PanelShell
			title={t("pair.title")}
			subtitle={t("pair.subtitle")}
			error={error}
			actions={
				currentRoom ? (
					<Button size="sm" variant="outline" onClick={() => void leave()}>
						{t("pair.leave")}
					</Button>
				) : (
					<Button size="sm" onClick={handleJoin} disabled={phase === "running" || !canJoin}>
						{t("pair.joinRoom")}
					</Button>
				)
			}
		>
			<Notice tone="accent" icon={Info} className="mb-3">
				{t("pair.localNotice")}
			</Notice>
			{currentRoom ? (
				<div className="space-y-3 text-sm">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="outline">
							{t("pair.roomLabel")} : {currentRoom.room_id}
						</Badge>
						<Badge variant="outline">
							{isStreaming ? t("pair.streaming") : t("pair.offline")}
						</Badge>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void inviteAi(t("pair.aiName"))}
							disabled={aiPresent}
						>
							<Bot className="mr-1 h-3.5 w-3.5" />
							{aiPresent ? t("pair.aiInRoom") : t("pair.inviteAi")}
						</Button>
					</div>

					<div>
						<div className="mb-1 font-medium">
							{t("pair.participants")} ({currentRoom.participants.length})
						</div>
						<ul className="flex flex-wrap gap-2">
							{currentRoom.participants.map((p) => (
								<li key={p.user_id} className="rounded border px-2 py-1 text-xs">
									{p.display_name}{" "}
									<span className="text-muted-foreground">
										({t(ROLE_KEYS[p.role] as never)})
									</span>
								</li>
							))}
						</ul>
					</div>

					<div className="space-y-1">
						<div className="font-medium">{t("pair.file")}</div>
						<p className="text-xs text-muted-foreground">
							{focusedFile ? (
								<span className="inline-flex items-center gap-1">
									<FileText className="h-3.5 w-3.5" />
									<code>{focusedFile}</code>
								</span>
							) : (
								t("pair.noFile")
							)}
						</p>
						<div className="flex gap-2">
							<Input
								value={fileInput}
								onChange={(e) => setFileInput(e.target.value.slice(0, PATH_MAX_LEN))}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										handleFocus(fileInput);
									}
								}}
								aria-label={t("pair.filePath")}
								placeholder={t("pair.filePlaceholder")}
								className="h-auto flex-1 p-2 font-mono text-xs"
							/>
							<Button
								size="sm"
								variant="outline"
								onClick={() => handleFocus(fileInput)}
								disabled={!fileInput.trim()}
							>
								{t("pair.setFile")}
							</Button>
							<Button size="sm" variant="outline" onClick={() => void handlePickFile()}>
								<FolderOpen className="mr-1 h-3.5 w-3.5" />
								{t("pair.pickFile")}
							</Button>
						</div>
						{pickFailed && (
							<p role="alert" className="text-xs text-destructive">
								{t("common.pickerFailed")}
							</p>
						)}
					</div>

					<div>
						<div className="mb-1 font-medium">{t("pair.recentOps")}</div>
						<div
							ref={opsScrollRef}
							className="max-h-80 space-y-2 overflow-auto rounded border bg-muted/20 p-2 text-xs"
						>
							{ops.length === 0 ? (
								<p className="text-muted-foreground">{t("pair.noOps")}</p>
							) : (
								ops.map((op) => (
									<div key={op.op_id} className="space-y-1">
										<div className="flex flex-wrap items-center gap-1">
											<Badge variant="outline" className="text-3xs">
												{t(`pair.opKinds.${op.kind}` as never, { defaultValue: op.kind })}
											</Badge>
											<span className="font-medium">{nameOf(op.actor)}</span>
											{op.kind === "chat" && (
												<span className="whitespace-pre-wrap">{text(op.payload.text)}</span>
											)}
											{(op.kind === "cursor" || op.kind === "edit") && (
												<code>{text(op.payload.file_path)}</code>
											)}
										</div>
										{op.kind === "suggestion" && (
											<div className="rounded border bg-background p-2">
												<p className="text-muted-foreground">
													{t("pair.suggestionFor", { file: text(op.payload.file_path) })}
												</p>
												<pre className="mt-1 max-h-64 overflow-auto font-mono text-3xs">
													{text(op.payload.suggestion)}
												</pre>
											</div>
										)}
									</div>
								))
							)}
						</div>
					</div>

					{aiThinking && (
						<p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							{t("pair.aiThinking")}
						</p>
					)}
					{aiErrorText && <p className="text-xs text-destructive">{aiErrorText}</p>}

					<form className="space-y-1" onSubmit={handleSubmitChat}>
						<div className="flex gap-2">
							<Input
								value={chatText}
								onChange={(e) => setChatText(e.target.value.slice(0, MESSAGE_MAX_LEN))}
								maxLength={MESSAGE_MAX_LEN}
								aria-label={t("pair.chatPlaceholder")}
								placeholder={aiPresent ? t("pair.chatPlaceholderAi") : t("pair.chatPlaceholder")}
								className="h-auto flex-1 p-2 text-sm"
							/>
							<Button type="submit" size="sm" disabled={chatText.trim().length === 0}>
								{t("pair.send")}
							</Button>
						</div>
					</form>
				</div>
			) : (
				<div className="grid grid-cols-3 gap-3 text-sm">
					<div>
						<label htmlFor="room-id-input" className="mb-1 block font-medium">
							{t("pair.roomId")}
						</label>
						<Input
							id="room-id-input"
							value={roomId}
							onChange={(e) => setRoomId(e.target.value.slice(0, 64))}
							maxLength={64}
							aria-invalid={Boolean(roomIdError) || undefined}
							aria-describedby={roomIdError ? "room-id-error" : undefined}
							className="h-auto w-full p-2 text-sm"
						/>
						{roomIdError && (
							<p id="room-id-error" className="mt-1 text-xs text-destructive">
								{roomIdError}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="display-name-input" className="mb-1 block font-medium">
							{t("pair.yourName")}
						</label>
						<Input
							id="display-name-input"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value.slice(0, NAME_MAX_LEN))}
							maxLength={NAME_MAX_LEN}
							aria-invalid={Boolean(nameError) || undefined}
							aria-describedby={nameError ? "display-name-error" : undefined}
							className="h-auto w-full p-2 text-sm"
						/>
						{nameError && (
							<p id="display-name-error" className="mt-1 text-xs text-destructive">
								{nameError}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="role-select" className="mb-1 block font-medium">
							{t("pair.role")}
						</label>
						<NativeSelect
							id="role-select"
							value={role}
							onChange={(e) => setRole(e.target.value as Role)}
							className="h-auto w-full p-2 text-sm"
						>
							{ROLES.map((r) => (
								<option key={r.value} value={r.value}>
									{t(r.labelKey as never)}
								</option>
							))}
						</NativeSelect>
					</div>
				</div>
			)}
		</PanelShell>
	);
}
