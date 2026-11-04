import type { ShoppingToolResult, ShoppingTools } from '../../agent/tools.ts'
import type { ChatSummary, MessagePage } from '../../store/types.ts'

/**
 * The HTTP API's wire types, for clients (`web/`, via `shopping-assistant/contract`).
 * **Types only**: importing this pulls no server code into a client bundle.
 * The shapes are described in 07 ("Routes", "Product card contract") and 08.
 */

export type { ProductCard, ProductListing } from '../../domain/product-card.ts'
export type { ShoppingToolResult }

/** Tool names. A tool part's `type` is `tool-<name>`; its `output` is a `ShoppingToolResult`. */
export type ShoppingToolName = keyof ShoppingTools

/** `GET /chats` items. Dates arrive as ISO strings. */
export type ChatSummaryJson = Omit<ChatSummary, 'createdAt' | 'updatedAt'> & { createdAt: string, updatedAt: string }

/** `GET /chats/:id/messages`: `{ messages: UIMessage[], hasMore }`. Already JSON-shaped. */
export type { MessagePage }

/** `POST /chats/:id/messages` body: only the new user message; the server holds the history. */
export type SendMessageBody = { message: { id?: string, role: 'user', parts: Array<{ type: 'text', text: string }> } }

/** Error responses (400 / 404 / 409 / 500). */
export type ErrorBody = { error: string }
