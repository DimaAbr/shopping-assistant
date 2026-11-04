# 05 — Phase 2: Shopping core

The phase plan and record for [03-roadmap.md](03-roadmap.md) phase 2. Decisions that change 02 are also noted there, with dates.

Phase 2 was **cut down** (2026-11-03) to the core loop: intent → query → tool call → grounded reply. The goal is an agent that doesn't hallucinate and handles missing information, empty results and API errors well, before adding refinements. Price filters, sorting, "cheaper", unsupported attributes, stock/shipping, product details and caching move to **phase 2b**.

## Decisions (2026-11-03)

| Topic | Decision | Notes |
|---|---|---|
| Tools | **Two tools, 1:1 with API endpoints:** `searchProducts({ query, limit? })` and `browseCategory({ category, limit? })` | No filtering in code. `limit` defaults to 5, max 10 |
| Category input | `category` is a **zod enum of the real slugs** | The model can't invent a category. The API would answer an unknown slug with an empty list, not an error |
| `getProduct` | **Dropped for this phase** | With the trimmed product model, search results already carry every field we model. Returns in 2b with product details |
| `listCategories` tool | **None.** Categories go into the prompt and the enum | 24 slugs, fetched once at startup by the CLI |
| Product model | id, title, description, category, price, rating, brand?, thumbnail. **Everything else is stripped on parse** | Stock, warranty, shipping, returns, reviews and images aren't modelled, so the agent has nothing to make claims about. The prompt tells it to say so |
| What the model sees | Product **without `thumbnail`**, plus `total` and `shown` | The full result (with thumbnail) stays in history for the UI later. *Correction (2026-11-04): it didn't, because `ModelMessage` history holds the model output. Fixed in phase 3 by storing `UIMessage`s, see 02 §14.7* |
| Tool errors | Tools **return a `status`** (`ok` / `empty` / `catalog_unavailable`) instead of throwing | An unambiguous signal the model reports, instead of a raw error it might paper over. Unexpected errors (bugs) still throw |
| Step limit | `prepareStep` sets **`toolChoice: 'none'` on the last allowed step** | A turn always ends in text, never on an unanswered tool call |
| Vague requests | **Ask first**, as 2–3 concrete category suggestions. If still vague, browse 1–3 plausible categories | Decided with the user during planning |
| HTTP mocking | **Injected `fetch`**, no msw | `createDummyJsonRepository({ fetch })` |
| Evals | **Plain vitest + a small harness**, not evalite | See "Evals" below |

## Live API findings (checked 2026-11-03)

- **Search is a substring match of the whole query** (case-insensitive) against title and description. It is *not* keyword matching:
  - `red lipstick` → 1
  - `lipstick red` → 0
  - `laptops` → 0 (plural)
  - `gift` → 0
  - `phone` → AirPods (matched on the description)

  So the tool description and prompt ask for a short **singular** phrase in title word order.
- **An unknown category returns `{products:[], total:0}`**, not a 404. That's why the enum matters.
- `/products/{bad id}` → 404 with a `message`. Not used yet.
- `/products/category-list` → a flat array of 24 slugs.
- **Category slugs can be misleading:** `tops` contains girls' frocks and dresses ("Blue Frock", "Girl Summer Dress"). See "Known issues".

## Layout

```
src/
  domain/products.ts            zod Product / ProductPage / category list schemas
  domain/product-repository.ts  ProductRepository + dummyjson impl, CatalogUnavailableError
  agent/tools.ts                searchProducts, browseCategory, toModelOutput
  agent/prompt.ts               buildInstructions(categories), pure
  agent/chat.ts                 + tools, + prepareStep (last step: no tools), + fullStream
  adapters/cli/main.ts          fetches categories once, prints a dim trace line per tool call
test/
  setup/no-network.ts           replaces global fetch with one that throws
  helpers/                      mock-model streams, fixtures loader, fake repository
  fixtures/dummyjson/*.json     recorded from the live API
  domain/, agent/               unit + mock-model tests
evals/
  vitest.config.ts              separate config: `pnpm eval`
  harness.ts                    converse(), runCase() (N trials, pass rate, results log)
  checks.ts                     code-based checks, incl. grounding
  shopping.eval.ts              the golden set
```

## Offline tests and the startup category fetch

- **Only the CLI fetches categories.** `buildInstructions` and `createShoppingTools` take them as data.
- Agent and chat tests use `createFakeRepository()` (fixtures in memory, with per-method overrides such as `unavailable`).
- Repository tests inject a fake `fetch`.
- `test/setup/no-network.ts` makes any real `fetch` in unit tests throw.
- Evals are online by design and run under their own config, without the guard.

## Evals

- **Why not evalite:** v0.19 is built on vitest 4's runner (we're on 5) and `@ai-sdk/provider` v2 (we're on v4). It also needs `better-sqlite3`, which 02 §6 rejected because of Windows native builds.
- **What we use instead:** `evals/` is a small harness on plain vitest.
  - Each case runs `EVAL_TRIALS` times (default 5) in parallel and must pass **≥ 80% (4/5)**.
  - Every run appends to `logs/evals/results.jsonl`: pass count, plus the failing turns with tool calls and replies. That's the history for comparing prompt changes.
  - Step logs go to `logs/eval-steps.jsonl`.
- **Grounding checks** (on every case):
  - Every catalog product title named in a reply was returned by a tool in that conversation.
  - Every `$` amount equals a returned product's price.
- **Cases:**
  - small talk
  - direct request
  - six vague requests: wife gift, party, son starting school, new apartment, beach holiday, working out. Each case has its own set of plausible categories
  - vague then still vague
  - two no-result requests: Google Pixel, air fryer
  - out of catalog (books)
  - missing information (warranty)

**Check limitations:**
- Single-word catalog titles ("Sunglasses", "Apple", "Water") are skipped by the product-name check, because they can't be told apart from ordinary words.
- Category suggestions are matched by a word table. An *invented* category with no matching word (e.g. "swimwear") isn't caught. Read the failures in the results log.

### Results (`gpt-6-luna`, 5 trials)

| Case | Run 1 | Run 2 |
|---|---|---|
| small talk | 5/5 | 5/5 |
| direct request | 5/5 | 5/5 |
| vague: gift for my wife | 5/5 | 5/5 |
| vague: throwing a party | 5/5 | 5/5 |
| vague: son starting school | 1/5 | 4/5 |
| vague: new apartment | 5/5 | 5/5 |
| vague: beach holiday | 0/5 † | 5/5 |
| vague: working out | 5/5 | 5/5 |
| vague, still vague | 5/5 | 5/5 |
| no results: Google Pixel | 0/5 † | 5/5 |
| no results: air fryer | 0/5 † | 5/5 |
| out of catalog: books | 0/5 † | 5/5 |
| missing info: warranty | 0/5 † | 5/5 |

† Run 1 failures were **checker bugs, not agent failures**. The agent's replies were correct; the check misjudged them:
- The model writes `don’t` with a typographic apostrophe; the patterns now normalise it.
- The single-word title "Sunglasses" matched the category word.
- Shoes for the beach are now allowed as plausible.

The prompt was not changed between the runs.

## Known issues

- **`tops` is misleading. Left open on purpose (2026-11-03).** The agent sometimes suggests "tops" for a boy, because it only sees the slug, and `tops` holds girls' dresses. In the school case this happened in 5 of 10 trials across both Linux runs, and the case failed on the Windows run. The fix depends on the data strategy chosen in phase 2b:
  - **Store the catalog locally:** recategorise or rename the category.
  - **Light pre-fetch:** fetch one or two items per category at startup, so the model sees what a category really holds.
  - **Treat it as a live, large, changing API that can't be pre-fetched:** check results against the request after the query. Then either fetch another page or treat the result as empty / out of stock.

## How to run

```sh
pnpm test        # offline: unit + mock-model + architecture tests
pnpm typecheck
pnpm chat        # needs OPENAI_API_KEY and network
pnpm eval        # real model + catalog; EVAL_TRIALS=5 by default
```

## Status

- [x] Domain unit tests pass: search/browse params, empty results, field stripping, HTTP 500 / network / timeout / bad JSON / bad shape → `CatalogUnavailableError`
- [x] Mock-model tests pass: tool dispatch, slim model output, `catalog_unavailable` reaches the model, last step forbids tools, tool results visible on later turns
- [x] Golden set ≥ 4/5 on every case (run 2). On Windows every case passed except the known `tops` case (school)
- [x] Grounding checks pass on every case
- [x] `pnpm chat` checked against the real model and catalog on Linux (WSL)
- [x] `pnpm chat` with an unreachable `DUMMYJSON_BASE_URL` exits with a clean error
- [x] Windows: install, tests and chat work (checked by the user, 2026-11-03)
