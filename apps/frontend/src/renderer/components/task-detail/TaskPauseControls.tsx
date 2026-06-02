import {
	Pause,
	Play,
	RotateCcw,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import { Button } from "../ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../ui/tooltip";

interface TaskPauseControlsProps {
	task: Task;
	isPaused?: boolean;
	onPause?: (subtaskId?: string) => Promise<void>;
	onResume?: () => Promise<void>;
	onSwitchProvider?: (provider: string, model: string) => Promise<void>;
}

const LLM_OPTIONS = [
	{ provider: "anthropic", label: "Claude (Anthropic)", models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"] },
	{ provider: "openai", label: "OpenAI", models: ["gpt-4o", "gpt-4-turbo", "gpt-4"] },
	{ provider: "google", label: "Google (Gemini)", models: ["gemini-pro", "gemini-2.0-flash"] },
];

export function TaskPauseControls({
	task,
	isPaused = false,
	onPause,
	onResume,
	onSwitchProvider,
}: TaskPauseControlsProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [isLoading, setIsLoading] = useState(false);
	const [selectedProvider, setSelectedProvider] = useState(
		task.metadata?.provider || "anthropic"
	);
	const [selectedModel, setSelectedModel] = useState(
		task.metadata?.model || "claude-opus-4-7"
	);

	const currentProviderOptions = LLM_OPTIONS.find(
		(opt) => opt.provider === selectedProvider
	);

	const handlePause = useCallback(async () => {
		setIsLoading(true);
		try {
			await onPause?.();
			toast({
				title: "Task paused",
				description: "You can resume later or switch providers",
			});
		} catch (error) {
			toast({
				title: "Failed to pause",
				description: String(error),
				variant: "destructive",
			});
		} finally {
			setIsLoading(false);
		}
	}, [onPause, toast]);

	const handleResume = useCallback(async () => {
		setIsLoading(true);
		try {
			await onResume?.();
			toast({
				title: "Task resumed",
				description: "Continuing from where you paused",
			});
		} catch (error) {
			toast({
				title: "Failed to resume",
				description: String(error),
				variant: "destructive",
			});
		} finally {
			setIsLoading(false);
		}
	}, [onResume, toast]);

	const handleSwitchProvider = useCallback(async () => {
		setIsLoading(true);
		try {
			await onSwitchProvider?.(selectedProvider, selectedModel);
			toast({
				title: "Provider switched",
				description: `Switched to ${selectedProvider} (${selectedModel})`,
			});
		} catch (error) {
			toast({
				title: "Failed to switch provider",
				description: String(error),
				variant: "destructive",
			});
		} finally {
			setIsLoading(false);
		}
	}, [selectedProvider, selectedModel, onSwitchProvider, toast]);

	return (
		<div className="space-y-4 p-4 border rounded-lg bg-muted/20">
			<div className="text-sm font-medium">
				{isPaused ? "Task is paused" : "Task controls"}
			</div>

			{!isPaused && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							onClick={handlePause}
							disabled={isLoading}
							className="w-full"
						>
							<Pause className="h-4 w-4 mr-2" />
							Pause
						</Button>
					</TooltipTrigger>
					<TooltipContent>Pause execution and save current state</TooltipContent>
				</Tooltip>
			)}

			{isPaused && (
				<>
					<div className="space-y-2">
						<label className="text-xs font-medium">Switch LLM Provider</label>
						<div className="space-y-2">
							<Select value={selectedProvider} onValueChange={setSelectedProvider}>
								<SelectTrigger className="h-8">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{LLM_OPTIONS.map((opt) => (
										<SelectItem key={opt.provider} value={opt.provider}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>

							{currentProviderOptions && (
								<Select value={selectedModel} onValueChange={setSelectedModel}>
									<SelectTrigger className="h-8">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{currentProviderOptions.models.map((model) => (
											<SelectItem key={model} value={model}>
												{model}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</div>
					</div>

					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleSwitchProvider}
							disabled={isLoading}
							className="flex-1"
						>
							<RotateCcw className="h-4 w-4 mr-2" />
							Apply
						</Button>

						<Button
							variant="default"
							size="sm"
							onClick={handleResume}
							disabled={isLoading}
							className="flex-1"
						>
							<Play className="h-4 w-4 mr-2" />
							Resume
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
