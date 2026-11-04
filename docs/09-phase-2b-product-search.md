# 09 — Phase 2b, part 1: consolidated product search (`findProducts`)

The phase plan and record for the first part of [03-roadmap.md](03-roadmap.md) phase 2b. Decisions that change 02 are also noted there, with dates.

Planned on 2026-11-04, after a live test of the MVP. "I'm starting to work out" got a good clarifying question. The answer "some accessories and shoes" then went wrong:

- **3 separate tool calls**, so 15 tiles in 3 lists
- **irrelevant results**: `searchProducts('shoe')` returned women's heels for a workout request
- **a reply that repeated the tiles** in text, with 3 picks

The causes: the chat agent drove raw 1:1 endpoint tools (substring search, misleading slugs like `tops`). Nothing merged results or checked them against the request. And the prompt asked for a product list in the reply.

## Goals

- **One tool call per request**, returning one consolidated result, grouped by kind of product.
- **Results checked against the request** (audience, purpose, budget) before anyone sees them.
- **A reply that doesn't repeat the tiles.**
- The same capability is what phase 8 exposes over MCP, so a host's model doesn't need to know our catalog quirks either.

## Decisions (2026-11-04)

| Topic | Decision | Notes |
|---|---|---|
| Shape | **A fixed workflow inside one tool**, not an open-ended sub-agent | Plan → run queries → price filter → relevance filter → at most one refill. Bounded model calls and API calls, mostly mock-testable. It can grow into an agent loop if evals show the need |
| Rejected: open-ended sub-agent | A `generateText` loop over the old tools | Less predictable cost and latency, harder to test, and no case needs it yet |
| Rejected: deterministic only | The main model passes structured queries; code merges and filters | Cheapest, but no relevance check, so heels stay in. MCP hosts would also have to learn the search quirks |
| Tool | **`findProducts({ request, minPrice?, maxPrice? })`** replaces `searchProducts` and `browseCategory` | `request` is free text holding the soft context (audience, purpose, style). The numbers are structured because **code** enforces them, never a model |
| Result | `ok { groups: [{ label, products }], unmet }` · `no_match { unmet }` · `catalog_unavailable` | One group per need. `unmet` lists the needs nothing was found for, so the reply can be honest about gaps |
| Model | New **`searcher`** role (`MODEL_SEARCHER`, default `gpt-6-luna`) | Planning and relevance calls. A cheaper model should do |
| Persistence | **Only the top-level call and its result** are stored | The workflow's model calls go to the step log (`scope: findProducts:plan` / `:relevance`, `chatId: tool:<toolCallId>`), never into chat history |
| Reply | **One lead-in line**, plus at most one sentence on unmet needs or a follow-up question | Products are discussed only when the user asks about specific ones. The model still sees the slim products, so follow-ups stay grounded |
| Old history | **Not supported** | `tool-searchProducts` / `tool-browseCategory` parts in stored chats no longer render. Wipe the dev DB (`data/shopping.db`) |
| No catalog knowledge in prompts | **Prompts describe how the API behaves, never what the catalog holds** (amended 2026-11-04) | A first version noted "`tops` holds girls' dresses" in both prompts. That was removed: with a real API we wouldn't know it. Data quirks are handled by general mechanisms: the relevance check on results, and "category names are only hints, search before saying we don't have it" in the chat prompt |

## Product fields (2026-11-04)

The search now uses more of the API's fields. We checked them against the live data first (194 products):

| Field | Data | Who sees it | Use |
|---|---|---|---|
| `tags` | 138 distinct values, descriptive (`athletic shoes`, `heel shoes`, `girls' dresses`) | the relevance step only | A better relevance signal than the category name |
| `availabilityStatus` | 176 In Stock, 14 Low Stock, 4 Out of Stock | code only | **Out of Stock is filtered out silently**, before relevance. Unknown counts as available. The chat prompt says every returned product is in stock |
| `shippingInformation` | six fixed strings, "Ships overnight" … "Ships in 1 month" | relevance, the chat model, the tiles | Relevance drops products that can't meet a stated deadline. The chat model can answer "how soon does it ship?". Tiles show it under the price |
| `weight`, `dimensions` | unitless numbers that look random (lipstick 1, trainers 6) | nobody | **Dropped**: no meaning in this data |

The chat agent carries timing into `request` ("needed within 2 days"). The grounding rule now lists shipping time as known data. Shipping costs, destinations, delivery dates and stock levels are still unknown.

## The workflow

`src/agent/search/find-products.ts`, a plain function the tool wraps:

1. **Plan** (`plan.ts`, one structured-output call). The request becomes 1–3 needs. Each need has a display label and up to 3 queries: category slugs (a zod enum) and keyword searches. The dummyjson search rules (one singular substring phrase, 02 §14.1 #1) moved here from the chat prompt. Caps are applied in code, not in the schema.
2. **Run** every query in parallel, 20 per page. Merge each need's results by id, drop out-of-stock products, then apply the price bounds.
3. **Relevance** (`relevance.ts`, one structured-output call). It sees the request and, per need, the candidates (id, title, category, brand, tags, shipping time, trimmed description). It returns the ids to keep, best first. **Ids that weren't offered for that need are dropped**, so this step can't add products.
4. **Refill once.** A need with fewer than 2 kept products, where a query has more pages, fetches the next page of those queries. Only the new candidates are judged.
5. **Assemble.** Up to 4 per group and 10 in total. A product appears in one group only.

Bounds: 2 model calls (3 with a refill, none for relevance if nothing survived the price filter). At most 9 catalog calls, plus 9 more for a refill (02 §5: don't overload the live API).

The deterministic parts are in the domain layer (`src/domain/product-search.ts`): `runQuery`, `hasMore`, `inPriceRange`, `dedupeById`, and the result schema. That keeps the client contract free of server modules (see "Behaviour worth knowing").

## Layout

```
src/domain/product-search.ts       queries, paging, price bounds, dedupe, ProductSearchResultSchema
src/domain/product-repository.ts   + optional `skip` on search / listByCategory (only sent when paging)
src/agent/search/plan.ts           planner: instructions, schema, normalizePlan (caps)
src/agent/search/relevance.ts      relevance filter: prompt, schema, offered-ids guard
src/agent/search/find-products.ts  the workflow
src/agent/search/log.ts            step-log handlers for the inner calls
src/agent/tools.ts                 findProducts tool, toModelOutput (slim groups), SHOPPING_TOOL_NAMES
src/agent/prompt.ts                findProducts rules, reply style, "category names are only hints"
test/helpers/search-model.ts       scripted searcher model (plan + keep), fixturePlan
test/helpers/fake-repository.ts    + createCatalogRepository (in-memory, dummyjson semantics), testShoppingTools
```

Clients: `ProductTiles` renders one section per group (headings only when there's more than one) and the `no_match` / unavailable states. The CLI trace line shows `Label: #ids · unmet: …`.

## Behaviour worth knowing

- **The client contract spells out the tool name** (`ShoppingToolName = 'findProducts'`) instead of deriving it from `agent/tools.ts`. Deriving it made the web typecheck follow `tools.ts` → the step logger → `node:fs` (the same trap as 02 §14.8 #3). A test checks that the names match.
- **A no-needs plan** (e.g. "books") returns `no_match` with the request itself as `unmet`, after one model call.
- **Planner or relevance failures throw** and reach the chat model as a tool error. Only catalog failures map to `catalog_unavailable`.
- **The catalog has no men's workout tops.** For "workout clothes for a man", the honest answer is an `unmet` group, not dresses from `tops`.

## Evals

The phase 2 cases moved from tool-name checks to result checks:
- `oneSearch`: exactly one `findProducts` call
- `returnedPlausible` / `returnedNoneFrom`: the returned categories
- `returnedTitle`, `returnedGroups`, `pricesAtMost`
- `noProductListing`: at most one product title and one price in the reply

"Direct request" no longer requires the reply to name the product. New cases: multi-need workout, budget, budget refinement, clothes for a boy.

### Results (`gpt-6-luna`, 5 trials)

Before (2026-11-04, old tools): 12/13 cases ≥ 4/5. The only failure was the school case, 3/5 (`tops`).

After (2026-11-04, final prompts, one full run): **17/17 cases at 5/5.**

**The school case is not fixed.** It scored 5/5 here and 3/5 one run earlier. Both runs had no catalog note; the earlier one also lacked the "category names are only hints" rule. It's a clarifying question ("tops, shoes or a tablet?"), which never reaches the search, so the relevance check can't help. Treat it as open and unstable (03 phase 2b).

How we got there:

1. **First run (with the `tops` note in both prompts):** 14/17. Three failures, all in the evals rather than the search:
- **budget, 0/5:** `groundedPrices` flagged the user's own "$100" echoed in "shoes under $100". It now allows amounts the user typed.
- **clothes for a boy, 0/5:** the model answered "we don't carry boys' clothes" without searching. That's correct: the catalog has none. The case wrongly required a search. It now checks that no tops or dresses are returned or offered.
- **appliance, 3/5:** "Nothing matched for air fryers" wasn't in the `NOT_FOUND` pattern. One trial also said "we don't carry air fryers" without searching. That's still counted as a failure.

2. **The `tops` note removed** (no catalog knowledge in prompts). Two problems showed up:
   - **multi-need, 2/5:** the relevance step sometimes dropped *all* 17 sports accessories (2 of 8 in a direct probe), deciding balls and rackets aren't "workout" gear. The rule now drops only clear misfits, and keeps loose fits and anything the shopper named as a kind of product: "when unsure, keep". After the change: 8/8 kept the accessories and 0/8 kept women's shoes.
   - **school, 3/5:** back to the original `tops` suggestion.

3. **Second full run:** 14/17.
   - **school, 3/5:** as above.
   - **appliance, 2/5:** one more regex gap ("No air fryers matched"). In two trials the model said "we don't carry air fryers" without searching, guessing from the category names. That's the same kind of assumption as the `tops` note. The chat prompt now says category names are only hints: search whenever a category could plausibly hold the item.
   - **budget refinement, 3/5:** "set maxPrice below the prices you showed" was read as below the *cheapest* (`maxPrice: 79.98`, nothing matched). It now says "just below the most expensive product you showed".

Manual end-to-end check (2026-11-04, `pnpm api`, live model, scratch DB):
- "I'm starting to work out…" → a clarifying question.
- "…some accessories and shoes" → **one** call, groups *Sports Accessories* (4 balls) and *Workout Shoes* (4 men's trainers/sneakers), no heels. Reply: "Here are some sports accessories and workout shoes to get you started."
- "anything under 100 dollars?" → `maxPrice: 99.99`, one shoe.
- "which would you pick for running?" → a grounded answer from that shoe's description.

### With the new product fields (2026-11-04, one full run)

**18/19 cases pass.** Every case also checks `inStockOnly`: no out-of-stock product is ever returned. New cases:
- **shipping deadline, 4/5:** "running shoes for a race… within 2 days". All returned shoes ship overnight or in 1–2 business days. The one failure returned nothing: no product is explicitly a running shoe (the Puma's tags say `casual shoes`), and the relevance step chose to be strict.
- **shipping question, 5/5:** "how soon would the first one ship?" is answered from `shippingInformation`.

The only failing case is **school, 3/5** (the open `tops` clarifying question). These fields can't affect it, since it never reaches the search.

Works on Windows (checked by the user, 2026-11-04): the results are clearly better than before.

## How to run

```sh
rm data/shopping.db         # old chats use the removed tool names
pnpm test && (cd web && pnpm test)
pnpm eval
pnpm api & pnpm web         # then replay: "I'm starting to work out" → "accessories and shoes"
```
