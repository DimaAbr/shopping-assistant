/** The headless core (08, "Core"): no styling, reusable by any host UI or embed. */
export type { ShoppingConfig } from './config.ts'
export { resolveUserId, ANONYMOUS_ID_KEY } from './identity.ts'
export { createApiClient, describeChatError, ApiError, USER_ID_HEADER, type ApiClient } from './api-client.ts'
export { ShoppingProvider, useApiClient, useChatList } from './provider.tsx'
export { useChatHistory, useEarlierMessages, useShoppingChat } from './use-shopping-chat.ts'
