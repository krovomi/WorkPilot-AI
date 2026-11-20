/**
 * MCP Builder — No-Code MCP Server Creator
 *
 * Visual interface for creating custom MCP servers without code.
 * Allows defining tools, parameters, and HTTP actions.
 */

import {
	ChevronRight,
	Code,
	Globe,
	Pencil,
	Plus,
	Save,
	Trash2,
	Wrench,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type {
	McpBuilderAction,
	McpBuilderActionType,
	McpBuilderParam,
	McpBuilderProject,
	McpBuilderTool,
} from "../../../shared/types/mcp-marketplace";
import {
	deleteBuilderProject,
	saveBuilderProject,
	useMcpMarketplaceStore,
} from "../../stores/mcp-marketplace-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

type HttpConfig = NonNullable<McpBuilderAction["http"]>;

const HTTP_METHODS: readonly HttpConfig["method"][] = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
];

const PARAM_TYPES: readonly McpBuilderParam["type"][] = [
	"string",
	"number",
	"boolean",
	"array",
	"object",
];

const ACTION_LABEL: Record<McpBuilderActionType, string> = {
	http_request: "mcpMarketplace.builder.httpRequest",
	transform: "mcpMarketplace.builder.transform",
	chain: "mcpMarketplace.builder.chain",
};

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEmptyTool(): McpBuilderTool {
	return {
		id: generateId(),
		name: "",
		description: "",
		parameters: [],
		action: {
			type: "http_request",
			http: {
				method: "GET",
				url: "",
			},
		},
	};
}

function createEmptyProject(): McpBuilderProject {
	return {
		id: generateId(),
		name: "",
		description: "",
		icon: "Wrench",
		color: "#6366F1",
		baseUrl: "",
		defaultHeaders: {},
		envVars: [],
		tools: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

export function McpBuilder() {
	const { t } = useTranslation(["common"]);
	const { builderProjects, isBuilderLoading } = useMcpMarketplaceStore(
		useShallow((s) => ({
			builderProjects: s.builderProjects,
			isBuilderLoading: s.isBuilderLoading,
		})),
	);

	const [editingProject, setEditingProject] =
		useState<McpBuilderProject | null>(null);
	const [editingToolId, setEditingToolId] = useState<string | null>(null);

	const handleNewProject = () => {
		setEditingProject(createEmptyProject());
		setEditingToolId(null);
	};

	const handleSelectProject = (project: McpBuilderProject) => {
		setEditingProject({ ...project, tools: [...project.tools] });
		setEditingToolId(null);
	};

	const handleSaveProject = async (project: McpBuilderProject) => {
		const saved = { ...project, updatedAt: new Date().toISOString() };
		setEditingProject(saved);
		await saveBuilderProject(saved);
	};

	const handleDeleteProject = async (id: string) => {
		if (await deleteBuilderProject(id)) {
			setEditingProject(null);
			setEditingToolId(null);
		}
	};

	if (isBuilderLoading) {
		return (
			<div
				className="flex-1 flex items-center justify-center"
				role="status"
				aria-label={t("common:loading")}
			>
				<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
			</div>
		);
	}

	return (
		<div className="relative z-[1] flex flex-1 overflow-hidden">
			{/* Sidebar: project list */}
			<div className="w-64 shrink-0 border-r border-dashed border-border flex flex-col">
				<div className="p-3 border-b border-border">
					<Button
						onClick={handleNewProject}
						className="w-full h-8 text-xs gap-1.5"
					>
						<Plus className="h-3.5 w-3.5" />
						{t("mcpMarketplace.builder.newProject")}
					</Button>
				</div>
				<div className="flex-1 overflow-auto p-2 space-y-1">
					{builderProjects.map((project) => (
						<button
							type="button"
							key={project.id}
							onClick={() => handleSelectProject(project)}
							aria-current={editingProject?.id === project.id ? "true" : undefined}
							className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
								editingProject?.id === project.id
									? "bg-primary/10 text-primary font-medium"
									: "hover:bg-muted text-foreground"
							}`}
						>
							<div
								className="w-5 h-5 rounded shrink-0 flex items-center justify-center text-white text-3xs font-bold"
								style={{ backgroundColor: project.color }}
								aria-hidden="true"
							>
								{project.name.charAt(0) || "?"}
							</div>
							<span className="truncate">
								{project.name || t("mcpMarketplace.builder.untitled")}
							</span>
						</button>
					))}
					{builderProjects.length === 0 && !editingProject && (
						<p className="text-xs text-muted-foreground text-center py-8 px-3">
							{t("mcpMarketplace.builder.emptyHint")}
						</p>
					)}
				</div>
			</div>

			{/* Main editor area */}
			{editingProject ? (
				<ProjectEditor
					project={editingProject}
					onChange={setEditingProject}
					editingToolId={editingToolId}
					onEditTool={setEditingToolId}
					onSave={() => handleSaveProject(editingProject)}
					onDelete={() => handleDeleteProject(editingProject.id)}
				/>
			) : (
				<div className="flex-1 flex flex-col items-center justify-center text-muted-foreground px-6">
					<Wrench className="h-16 w-16 mb-4 opacity-20" />
					<h2 className="text-lg font-medium mb-1">
						{t("mcpMarketplace.builder.welcome")}
					</h2>
					<p className="text-sm text-center max-w-md mb-4">
						{t("mcpMarketplace.builder.welcomeHint")}
					</p>
					<Button onClick={handleNewProject} className="gap-1.5">
						<Plus className="h-4 w-4" />
						{t("mcpMarketplace.builder.newProject")}
					</Button>
				</div>
			)}
		</div>
	);
}

interface ProjectEditorProps {
	readonly project: McpBuilderProject;
	readonly onChange: (project: McpBuilderProject) => void;
	readonly editingToolId: string | null;
	readonly onEditTool: (toolId: string | null) => void;
	readonly onSave: () => void;
	readonly onDelete: () => void;
}

/** The server's settings, its tools, and the tool being edited. */
function ProjectEditor({
	project,
	onChange,
	editingToolId,
	onEditTool,
	onSave,
	onDelete,
}: ProjectEditorProps) {
	const { t } = useTranslation(["common"]);
	const ids = useId();
	// A parameter has no id of its own: its row keeps the key it was first
	// given while it is edited, so its inputs keep focus as its name changes.
	const paramKeys = useRef(new WeakMap<McpBuilderParam, string>());
	const keyOf = (param: McpBuilderParam): string => {
		let key = paramKeys.current.get(param);
		if (!key) {
			key = generateId();
			paramKeys.current.set(param, key);
		}
		return key;
	};

	const updateProject = (updates: Partial<McpBuilderProject>) =>
		onChange({ ...project, ...updates });

	const mapTool = (toolId: string, fn: (tool: McpBuilderTool) => McpBuilderTool) =>
		updateProject({
			tools: project.tools.map((tool) => (tool.id === toolId ? fn(tool) : tool)),
		});

	const handleAddTool = () => {
		const tool = createEmptyTool();
		updateProject({ tools: [...project.tools, tool] });
		onEditTool(tool.id);
	};

	const handleRemoveTool = (toolId: string) => {
		updateProject({ tools: project.tools.filter((tool) => tool.id !== toolId) });
		onEditTool(null);
	};

	const handleUpdateTool = (toolId: string, updates: Partial<McpBuilderTool>) =>
		mapTool(toolId, (tool) => ({ ...tool, ...updates }));

	const handleAddParam = (toolId: string) => {
		const param: McpBuilderParam = {
			name: "",
			type: "string",
			description: "",
			required: true,
		};
		mapTool(toolId, (tool) => ({ ...tool, parameters: [...tool.parameters, param] }));
	};

	const handleRemoveParam = (toolId: string, paramIndex: number) =>
		mapTool(toolId, (tool) => ({
			...tool,
			parameters: tool.parameters.filter((_, i) => i !== paramIndex),
		}));

	const handleUpdateParam = (
		toolId: string,
		paramIndex: number,
		updates: Partial<McpBuilderParam>,
	) =>
		mapTool(toolId, (tool) => ({
			...tool,
			parameters: tool.parameters.map((param, i) => {
				if (i !== paramIndex) return param;
				const next = { ...param, ...updates };
				paramKeys.current.set(next, keyOf(param));
				return next;
			}),
		}));

	const editingTool = project.tools.find((tool) => tool.id === editingToolId);
	const http: HttpConfig = editingTool?.action.http ?? { method: "GET", url: "" };
	const updateHttp = (tool: McpBuilderTool, updates: Partial<HttpConfig>) =>
		handleUpdateTool(tool.id, {
			action: { ...tool.action, http: { ...http, ...updates } },
		});

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Project header bar */}
			<div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border bg-background">
				<div className="flex items-center gap-3">
					<div
						className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold"
						style={{ backgroundColor: project.color }}
						aria-hidden="true"
					>
						{project.name.charAt(0) || "?"}
					</div>
					<div>
						<h2 className="font-medium text-sm">
							{project.name || t("mcpMarketplace.builder.untitled")}
						</h2>
						<p className="text-xs text-muted-foreground">
							{project.tools.length} {t("mcpMarketplace.builder.tools")}
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={onDelete}>
						<Trash2 className="h-3.5 w-3.5 mr-1.5" />
						{t("common:delete")}
					</Button>
					<Button size="sm" onClick={onSave}>
						<Save className="h-3.5 w-3.5 mr-1.5" />
						{t("common:save")}
					</Button>
				</div>
			</div>

			{/* Two-column layout: tools list + tool editor */}
			<div className="flex-1 flex overflow-hidden">
				{/* Left: project config + tools list */}
				<div className="w-80 shrink-0 border-r border-border overflow-auto p-4 space-y-5">
					{/* Project details */}
					<div className="space-y-3">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							{t("mcpMarketplace.builder.serverConfig")}
						</h3>
						<div className="space-y-2">
							<div>
								<Label htmlFor={`${ids}-name`} className="text-xs">
									{t("mcpMarketplace.builder.serverName")}
								</Label>
								<Input
									id={`${ids}-name`}
									value={project.name}
									onChange={(e) => updateProject({ name: e.target.value })}
									placeholder={t("common:mcpMarketplace.builder.namePlaceholder")}
									className="h-8 text-sm mt-1"
								/>
							</div>
							<div>
								<Label htmlFor={`${ids}-description`} className="text-xs">
									{t("mcpMarketplace.builder.description")}
								</Label>
								<Textarea
									id={`${ids}-description`}
									value={project.description}
									onChange={(e) => updateProject({ description: e.target.value })}
									placeholder={t("common:mcpMarketplace.builder.descriptionPlaceholder")}
									className="text-sm mt-1 min-h-[60px]"
								/>
							</div>
							<div>
								<Label htmlFor={`${ids}-base-url`} className="text-xs">
									{t("mcpMarketplace.builder.baseUrl")}
								</Label>
								<Input
									id={`${ids}-base-url`}
									value={project.baseUrl ?? ""}
									onChange={(e) => updateProject({ baseUrl: e.target.value })}
									placeholder="https://api.example.com"
									className="h-8 text-sm mt-1"
								/>
							</div>
							<div>
								<Label htmlFor={`${ids}-color`} className="text-xs">
									{t("mcpMarketplace.builder.color")}
								</Label>
								<div className="flex gap-2 mt-1">
									<input
										id={`${ids}-color`}
										type="color"
										value={project.color}
										onChange={(e) => updateProject({ color: e.target.value })}
										className="w-8 h-8 rounded border border-border cursor-pointer"
									/>
									<Input
										aria-label={t("mcpMarketplace.builder.colorCode")}
										value={project.color}
										onChange={(e) => updateProject({ color: e.target.value })}
										className="h-8 text-sm flex-1"
									/>
								</div>
							</div>
						</div>
					</div>

					{/* Tools list */}
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								{t("mcpMarketplace.builder.tools")}
							</h3>
							<Button
								variant="ghost"
								size="icon"
								className="h-6 w-6"
								onClick={handleAddTool}
								aria-label={t("mcpMarketplace.builder.addTool")}
								title={t("mcpMarketplace.builder.addTool")}
							>
								<Plus className="h-3.5 w-3.5" aria-hidden="true" />
							</Button>
						</div>
						{project.tools.length === 0 ? (
							<p className="text-xs text-muted-foreground py-4 text-center">
								{t("mcpMarketplace.builder.noTools")}
							</p>
						) : (
							<div className="space-y-1">
								{project.tools.map((tool) => (
									<button
										type="button"
										key={tool.id}
										onClick={() => onEditTool(tool.id)}
										aria-current={editingToolId === tool.id ? "true" : undefined}
										className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
											editingToolId === tool.id
												? "bg-primary/10 text-primary"
												: "hover:bg-muted"
										}`}
									>
										<Code className="h-3.5 w-3.5 shrink-0" />
										<span className="truncate flex-1">
											{tool.name || t("mcpMarketplace.builder.untitledTool")}
										</span>
										<Badge variant="secondary" className="text-3xs px-1">
											{t(ACTION_LABEL[tool.action.type])}
										</Badge>
										<ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
									</button>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Right: tool editor */}
				<div className="flex-1 overflow-auto p-5">
					{editingTool ? (
						<div className="max-w-2xl space-y-5">
							<div className="flex items-center justify-between">
								<h3 className="font-medium text-sm flex items-center gap-2">
									<Pencil className="h-4 w-4 text-primary" />
									{t("mcpMarketplace.builder.editTool")}
								</h3>
								<Button
									variant="ghost"
									size="sm"
									className="text-destructive hover:text-destructive"
									onClick={() => handleRemoveTool(editingTool.id)}
								>
									<Trash2 className="h-3.5 w-3.5 mr-1" />
									{t("mcpMarketplace.builder.removeTool")}
								</Button>
							</div>

							{/* Tool name + description */}
							<div className="grid grid-cols-2 gap-3">
								<div>
									<Label htmlFor={`${ids}-tool-name`} className="text-xs">
										{t("mcpMarketplace.builder.toolName")}
									</Label>
									<Input
										id={`${ids}-tool-name`}
										value={editingTool.name}
										onChange={(e) =>
											handleUpdateTool(editingTool.id, { name: e.target.value })
										}
										placeholder="get_users"
										className="h-8 text-sm mt-1 font-mono"
									/>
								</div>
								<div>
									<Label htmlFor={`${ids}-tool-description`} className="text-xs">
										{t("mcpMarketplace.builder.toolDescription")}
									</Label>
									<Input
										id={`${ids}-tool-description`}
										value={editingTool.description}
										onChange={(e) =>
											handleUpdateTool(editingTool.id, {
												description: e.target.value,
											})
										}
										placeholder={t("common:mcpMarketplace.builder.toolDescriptionPlaceholder")}
										className="h-8 text-sm mt-1"
									/>
								</div>
							</div>

							{/* Action type */}
							<div>
								<Label htmlFor={`${ids}-action-type`} className="text-xs">
									{t("mcpMarketplace.builder.actionType")}
								</Label>
								<Select
									value={editingTool.action.type}
									onValueChange={(val) =>
										handleUpdateTool(editingTool.id, {
											action: {
												...editingTool.action,
												type: val as McpBuilderActionType,
											},
										})
									}
								>
									<SelectTrigger id={`${ids}-action-type`} className="h-8 text-sm mt-1">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="http_request">
											<span className="flex items-center gap-1.5">
												<Globe className="h-3.5 w-3.5" />
												{t("common:mcpMarketplace.builder.httpRequest")}
											</span>
										</SelectItem>
										<SelectItem value="transform">
											<span className="flex items-center gap-1.5">
												<Code className="h-3.5 w-3.5" />
												{t("common:mcpMarketplace.builder.transform")}
											</span>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{/* HTTP action config */}
							{editingTool.action.type === "http_request" && (
								<div className="space-y-3 p-3 rounded-lg border border-border bg-muted/20">
									<h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
										<Globe className="h-3.5 w-3.5" />
										{t("common:mcpMarketplace.builder.httpConfiguration")}
									</h4>
									<div className="flex gap-2">
										<Select
											value={http.method}
											onValueChange={(val) =>
												updateHttp(editingTool, { method: val as HttpConfig["method"] })
											}
										>
											<SelectTrigger
												aria-label={t("mcpMarketplace.builder.httpMethod")}
												className="w-28 h-8 text-sm"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{HTTP_METHODS.map((m) => (
													<SelectItem key={m} value={m}>
														{m}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<Input
											aria-label={t("mcpMarketplace.builder.httpPath")}
											value={http.url}
											onChange={(e) => updateHttp(editingTool, { url: e.target.value })}
											placeholder="/api/users"
											className="h-8 text-sm flex-1 font-mono"
										/>
									</div>
									<div>
										<Label htmlFor={`${ids}-body`} className="text-xs">
											{t("mcpMarketplace.builder.bodyTemplate")}
										</Label>
										<Textarea
											id={`${ids}-body`}
											value={http.bodyTemplate ?? ""}
											onChange={(e) =>
												updateHttp(editingTool, { bodyTemplate: e.target.value })
											}
											placeholder='{"name": "{{name}}", "email": "{{email}}"}'
											className="text-xs font-mono mt-1 min-h-[80px]"
										/>
									</div>
								</div>
							)}

							{/* Transform action config */}
							{editingTool.action.type === "transform" && (
								<div className="space-y-3 p-3 rounded-lg border border-border bg-muted/20">
									<h4
										id={`${ids}-transform`}
										className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"
									>
										<Code className="h-3.5 w-3.5" />
										{t("common:mcpMarketplace.builder.transformTemplate")}
									</h4>
									<Textarea
										aria-labelledby={`${ids}-transform`}
										value={editingTool.action.transform?.template ?? ""}
										onChange={(e) =>
											handleUpdateTool(editingTool.id, {
												action: {
													...editingTool.action,
													transform: { template: e.target.value },
												},
											})
										}
										placeholder={t("common:mcpMarketplace.builder.transformPlaceholder")}
										className="text-xs font-mono min-h-[100px]"
									/>
								</div>
							)}

							{/* Parameters */}
							<div className="space-y-3">
								<div className="flex items-center justify-between">
									<h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										{t("mcpMarketplace.builder.parameters")}
									</h4>
									<Button
										variant="outline"
										size="sm"
										className="h-7 text-xs gap-1"
										onClick={() => handleAddParam(editingTool.id)}
									>
										<Plus className="h-3 w-3" />
										{t("mcpMarketplace.builder.addParam")}
									</Button>
								</div>

								{editingTool.parameters.length === 0 ? (
									<p className="text-xs text-muted-foreground text-center py-3">
										{t("mcpMarketplace.builder.noParams")}
									</p>
								) : (
									<div className="space-y-2">
										{editingTool.parameters.map((param, index) => (
											<div
												key={keyOf(param)}
												className="flex items-start gap-2 p-2 rounded-lg border border-border bg-background"
											>
												<div className="grid grid-cols-3 gap-2 flex-1">
													<Input
														aria-label={t("mcpMarketplace.builder.paramName")}
														value={param.name}
														onChange={(e) =>
															handleUpdateParam(editingTool.id, index, {
																name: e.target.value,
															})
														}
														placeholder="param_name"
														className="h-7 text-xs font-mono"
													/>
													<Select
														value={param.type}
														onValueChange={(val) =>
															handleUpdateParam(editingTool.id, index, {
																type: val as McpBuilderParam["type"],
															})
														}
													>
														<SelectTrigger
															aria-label={t("mcpMarketplace.builder.paramType")}
															className="h-7 text-xs"
														>
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{PARAM_TYPES.map((type) => (
																<SelectItem key={type} value={type}>
																	{t(`mcpMarketplace.builder.paramTypes.${type}`)}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
													<Input
														aria-label={t("mcpMarketplace.builder.paramDescription")}
														value={param.description}
														onChange={(e) =>
															handleUpdateParam(editingTool.id, index, {
																description: e.target.value,
															})
														}
														placeholder={t("common:mcpMarketplace.builder.paramDescriptionPlaceholder")}
														className="h-7 text-xs"
													/>
												</div>
												<Button
													variant="ghost"
													size="icon"
													className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
													onClick={() => handleRemoveParam(editingTool.id, index)}
													aria-label={t("mcpMarketplace.builder.removeParam")}
													title={t("mcpMarketplace.builder.removeParam")}
												>
													<Trash2 className="h-3 w-3" aria-hidden="true" />
												</Button>
											</div>
										))}
									</div>
								)}
							</div>
						</div>
					) : (
						<div className="flex flex-col items-center justify-center h-full text-muted-foreground">
							<Wrench className="h-12 w-12 mb-3 opacity-20" />
							<p className="text-sm">{t("mcpMarketplace.builder.selectTool")}</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
