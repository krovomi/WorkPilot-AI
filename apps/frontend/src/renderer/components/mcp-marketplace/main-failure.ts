/** The reasons the main process gives for a marketplace call, worded here. */

import type { TFunction } from "i18next";
import { isMcpMarketplaceFailure } from "../../../shared/types/mcp-marketplace";

/**
 * `text` in the app's language when it is a code of the main process
 * (`McpMarketplaceFailure`); any other text (a rejected call's own message)
 * as it is.
 */
export function mainFailureText(t: TFunction, text: string): string {
	return isMcpMarketplaceFailure(text) ? t(`common:mcpMarketplace.failures.${text}`) : text;
}
