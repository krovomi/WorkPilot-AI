/**
 * Renderer Logger Service
 * =======================
 *
 * Service de logging pour le processus renderer (frontend), écrit dans la
 * console du renderer (DevTools).
 *
 * Il envoyait chaque message au main process sur le canal `renderer-log`, que
 * personne n'écoutait : `setupRendererLogHandler` n'a jamais été appelé, si
 * bien que tout ce qui passait par ici disparaissait sans trace. Le brancher
 * aurait écrit chaque `debug` du renderer dans le stderr du main process, en
 * production comme en développement — rien ne filtre par niveau, ni ici ni
 * dans `colored-logs`. La console de DevTools, elle, range `debug` sous
 * « Verbose », masqué par défaut : c'est le filtre qui manquait.
 *
 * Usage:
 * import { rendererLog } from './renderer-logger';
 *
 * rendererLog.debug('Composant monté');
 * rendererLog.info('Action utilisateur');
 * rendererLog.error('Erreur survenue');
 */

// Interface pour les messages de log
interface LogMessage {
	level: "debug" | "info" | "success" | "warning" | "error";
	message: string;
	module?: string;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	args?: any[];
}

// Service de logging pour le renderer
export const rendererLog = {
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	debug: (message: string, ...args: any[]) => {
		const logMessage: LogMessage = {
			level: "debug",
			message,
			module: "renderer",
			args,
		};
		writeToConsole(logMessage);
	},

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	info: (message: string, ...args: any[]) => {
		const logMessage: LogMessage = {
			level: "info",
			message,
			module: "renderer",
			args,
		};
		writeToConsole(logMessage);
	},

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	success: (message: string, ...args: any[]) => {
		const logMessage: LogMessage = {
			level: "success",
			message,
			module: "renderer",
			args,
		};
		writeToConsole(logMessage);
	},

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	warning: (message: string, ...args: any[]) => {
		const logMessage: LogMessage = {
			level: "warning",
			message,
			module: "renderer",
			args,
		};
		writeToConsole(logMessage);
	},

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	error: (message: string, ...args: any[]) => {
		const logMessage: LogMessage = {
			level: "error",
			message,
			module: "renderer",
			args,
		};
		writeToConsole(logMessage);
	},

	// Module-specific loggers
	context: {
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		debug: (message: string, ...args: any[]) => {
			writeToConsole({ level: "debug", message, module: "context", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		info: (message: string, ...args: any[]) => {
			writeToConsole({ level: "info", message, module: "context", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		success: (message: string, ...args: any[]) => {
			writeToConsole({ level: "success", message, module: "context", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		warning: (message: string, ...args: any[]) => {
			writeToConsole({ level: "warning", message, module: "context", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		error: (message: string, ...args: any[]) => {
			writeToConsole({ level: "error", message, module: "context", args });
		},
	},

	github: {
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		debug: (message: string, ...args: any[]) => {
			writeToConsole({ level: "debug", message, module: "github", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		info: (message: string, ...args: any[]) => {
			writeToConsole({ level: "info", message, module: "github", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		success: (message: string, ...args: any[]) => {
			writeToConsole({ level: "success", message, module: "github", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		warning: (message: string, ...args: any[]) => {
			writeToConsole({ level: "warning", message, module: "github", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		error: (message: string, ...args: any[]) => {
			writeToConsole({ level: "error", message, module: "github", args });
		},
	},

	azure: {
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		debug: (message: string, ...args: any[]) => {
			writeToConsole({ level: "debug", message, module: "azure", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		info: (message: string, ...args: any[]) => {
			writeToConsole({ level: "info", message, module: "azure", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		success: (message: string, ...args: any[]) => {
			writeToConsole({ level: "success", message, module: "azure", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		warning: (message: string, ...args: any[]) => {
			writeToConsole({ level: "warning", message, module: "azure", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		error: (message: string, ...args: any[]) => {
			writeToConsole({ level: "error", message, module: "azure", args });
		},
	},

	changelog: {
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		debug: (message: string, ...args: any[]) => {
			writeToConsole({ level: "debug", message, module: "changelog", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		info: (message: string, ...args: any[]) => {
			writeToConsole({ level: "info", message, module: "changelog", args });
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		success: (message: string, ...args: any[]) => {
			writeToConsole({
				level: "success",
				message,
				module: "changelog",
				args,
			});
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		warning: (message: string, ...args: any[]) => {
			writeToConsole({
				level: "warning",
				message,
				module: "changelog",
				args,
			});
		},
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		error: (message: string, ...args: any[]) => {
			writeToConsole({ level: "error", message, module: "changelog", args });
		},
	},
};

// Écrit le message dans la console du renderer, préfixé de son module.
function writeToConsole(logMessage: LogMessage): void {
	const { level, message, module = "renderer", args = [] } = logMessage;
	const text = module === "renderer" ? message : `[${module}] ${message}`;
	switch (level) {
		case "debug":
			// biome-ignore lint/suspicious/noConsole: DevTools shows debug as "Verbose", hidden by default
			console.debug(text, ...args);
			break;
		case "info":
		case "success":
			console.info(text, ...args);
			break;
		case "warning":
			console.warn(text, ...args);
			break;
		case "error":
			console.error(text, ...args);
			break;
	}
}

// Export convenience functions
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
export const logRendererDebug = (message: string, ...args: any[]) =>
	rendererLog.debug(message, ...args);
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
export const logRendererInfo = (message: string, ...args: any[]) =>
	rendererLog.info(message, ...args);
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
export const logRendererSuccess = (message: string, ...args: any[]) =>
	rendererLog.success(message, ...args);
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
export const logRendererWarning = (message: string, ...args: any[]) =>
	rendererLog.warning(message, ...args);
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
export const logRendererError = (message: string, ...args: any[]) =>
	rendererLog.error(message, ...args);

export default rendererLog;
