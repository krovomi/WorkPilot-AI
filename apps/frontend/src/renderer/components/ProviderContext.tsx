import type React from "react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import type { Task } from "../../shared/types";
import { enginePhaseForPause } from "../../shared/utils/task-engine";
import { useSettingsStore } from "../stores/settings-store";
import { useTaskStore } from "../stores/task-store";

/**
 * Two providers, two questions.
 *
 * `selectedProvider` is the **default provider** (Settings → Agent): it seeds
 * a new task's engine and answers for the features that have no selector of
 * their own. It never changes a task that exists — each task owns its engine
 * (shared/utils/task-engine.ts).
 *
 * `usageProvider` is the provider the usage badges of the header observe.
 * Several tasks can run on several providers at once, so it follows the
 * tasks in progress unless the person picks one (`usageProviderChoice`),
 * and picking one changes nothing but what the badges show.
 */
interface ProviderContextType {
	selectedProvider: string;
	setSelectedProvider: (provider: string) => void;
	usageProvider: string;
	/** The provider picked for the badges, or null to follow running tasks. */
	usageProviderChoice: string | null;
	setUsageProviderChoice: (provider: string | null) => void;
	/** The providers of the phases running now, each once. */
	runningProviders: string[];
}

export const ProviderContext = createContext<ProviderContextType | undefined>(
	undefined,
);

interface ProviderContextProviderProps {
	children: ReactNode;
}

const USAGE_PROVIDER_KEY = "usageProvider";

/** The badges speak "anthropic"; a task may say "claude". */
function badgeProviderName(provider: string): string {
	const name = provider.trim().toLowerCase();
	return name === "claude" ? "anthropic" : name;
}

/**
 * The providers of the phases running now, as a stable string: the task store
 * changes on every progress event, and the context must not.
 */
export function runningProvidersKey(tasks: readonly Task[]): string {
	const providers: string[] = [];
	for (const task of tasks) {
		if (task.status !== "in_progress" && task.status !== "ai_review") continue;
		if (task.metadata?.paused?.enabled) continue;
		const phase = enginePhaseForPause(task.executionProgress?.phase);
		const provider =
			task.metadata?.phaseProviders?.[phase] || task.metadata?.provider;
		if (!provider) continue;
		const name = badgeProviderName(provider);
		if (!providers.includes(name)) providers.push(name);
	}
	return providers.join(",");
}

function readStored(key: string): string {
	try {
		return localStorage.getItem(key) || "";
	} catch {
		return "";
	}
}

export const ProviderContextProvider: React.FC<
	ProviderContextProviderProps
> = ({ children }) => {
	// Initialize from localStorage to avoid the empty-provider window on mount.
	// ProviderSelector persists the selection to localStorage on change,
	// so this gives UsageIndicator a valid provider immediately instead of ''
	// which would cause a brief "N/D" flash before the context is populated.
	const [storedProvider, setSelectedProvider] = useState<string>(() =>
		readStored("selectedProvider"),
	);
	// settings.json answers when this machine never picked one in the UI: it is
	// what the main process reads as the default provider.
	const settingsProvider = useSettingsStore((s) => s.settings?.selectedProvider);
	const selectedProvider =
		storedProvider ||
		(typeof settingsProvider === "string" ? settingsProvider : "");
	const [usageProviderChoice, setChoice] = useState<string | null>(
		() => readStored(USAGE_PROVIDER_KEY) || null,
	);
	const runningKey = useTaskStore((s) => runningProvidersKey(s.tasks));
	const runningProviders = useMemo(
		() => (runningKey ? runningKey.split(",") : []),
		[runningKey],
	);

	const setUsageProviderChoice = useCallback((provider: string | null) => {
		setChoice(provider);
		try {
			if (provider) localStorage.setItem(USAGE_PROVIDER_KEY, provider);
			else localStorage.removeItem(USAGE_PROVIDER_KEY);
		} catch {
			/* storage unavailable: the choice lasts for this session */
		}
	}, []);

	const usageProvider =
		usageProviderChoice ||
		runningProviders[0] ||
		(selectedProvider ? badgeProviderName(selectedProvider) : "");

	const contextValue = useMemo(
		() => ({
			selectedProvider,
			setSelectedProvider,
			usageProvider,
			usageProviderChoice,
			setUsageProviderChoice,
			runningProviders,
		}),
		[
			selectedProvider,
			usageProvider,
			usageProviderChoice,
			setUsageProviderChoice,
			runningProviders,
		],
	);

	return (
		<ProviderContext.Provider value={contextValue}>
			{children}
		</ProviderContext.Provider>
	);
};

export const useProviderContext = () => {
	const context = useContext(ProviderContext);
	if (!context) {
		throw new Error(
			"useProviderContext must be used within a ProviderContextProvider",
		);
	}
	return context;
};
