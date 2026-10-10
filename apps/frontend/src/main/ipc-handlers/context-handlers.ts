/**
 * Context Handlers
 *
 * This module serves as the entry point for all context-related IPC handlers.
 * The implementation has been refactored into smaller, focused modules in the context/ subdirectory:
 *
 * - utils.ts: Shared utility functions for environment parsing and configuration
 * - memory-status-handlers.ts: Handlers for checking Graphiti/memory configuration
 * - memory-data-handlers.ts: Handlers for getting and searching memories
 * - project-context-handlers.ts: Handlers for project context and index operations
 *
 * All handlers are registered through the main registerContextHandlers function.
 */

export { registerContextHandlers } from "./context";
