import type { ProductSearchResult } from '../../domain/product-search.ts'
import type { ChatSummary, MessagePage } from '../../store/types.ts'

/**
 * The HTTP API's wire types, for clients (`web/`, via `shopping-assistant/contract`).
 * **Types only**: importing this pulls no server code into a client bundle.
 * The shapes are described in 07 ("Routes", "Product card contract") and 08.
 */

export type { ProductCard, ProductListing } from '../../domain/product-card.ts'
/** A shopping tool part's `output` (09). Same as `ShoppingToolResult` in agent/tools.ts. */
export type ShoppingToolResult = ProductSearchResult

/**
 * Tool names. A tool part's `type` is `tool-<name>`; its `output` is a `ShoppingToolResult`.
 * Spelled out rather than derived from agent/tools.ts, so clients never type-check
 * server modules (see `SHOPPING_TOOL_NAMES`).
 */
export type ShoppingToolName = 'findProducts'

/** `GET /chats` items. Dates arrive as ISO strings. */
export type ChatSummaryJson = Omit<ChatSummary, 'createdAt' | 'updatedAt'> & { createdAt: string, updatedAt: string }

/** `GET /chats/:id/messages`: `{ messages: UIMessage[], hasMore }`. Already JSON-shaped. */
export type { MessagePage }

/** `POST /chats/:id/messages` body: only the new user message; the server holds the history. */
export type SendMessageBody = { message: { id?: string, role: 'user', parts: Array<{ type: 'text', text: string }> } }

/** Error responses (400 / 404 / 409 / 500). */
export type ErrorBody = { error: string }
