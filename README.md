# Methodology and mindset

Working with LLMs can introduce quite a lot of obfuscation and can make it difficult to pick apart deliberate decisions from LLM-made choices.
So for the sake of full transparency, I'm providing my full thought process in this repo.
I'd provide my claude-code chat logs but I'm not LLM-savy enough to know how to pull them.

I'm making a deliberate choice to avoid amending or rebasing commits post-date (which I usually do quite a lot to ensure a clean and readable commit-history) so that commit timestamps can reflect the timeline for this project without having to dig through authored vs committed dates for each commit.

I'm also keeping all design docs, plans, and deliberations logged in the `docs` folder.
As a rule of thumb:
- Claude summaries of planning and deliberation sessions will be stored in separate `.md` files, numbered in order.
- My personal notes and thoughts will change from commit to commit in the `notes-to-self.txt` file and any other plain text files that might pop up next to it. As a human, it's easier to clean up finished and irrelevant things and use multiple files than to keep a structured log of my thoughts.
- The main exception to this rule will be this `README.md` file which I will keep fully hand-authored throughout the entire project.

This actually reflects how I tend to work (except that I keep all those notes locally and don't commit them). Having pretty severe ADHD, I tend to fluctuate between remembering every decision that's been made about the product in the past 5 years, to not knowing what I wanted to do 5 minutes ago. So those little notes and TODO files are what keeps me in check at all times.

I hope that the docs, notes, and commit messages provide some initial insight into my thought process and working habits.

# My Background

I don't have much of a background with AI driven systems. And I'm not a huge LLM user personally. I only started using `claude-code` after taking a year off work in 2026, specifically to practice and learn to use it and I don't use any other LLMs for non software-related goals.

My main relevant experience is designing a prototype for a LangChain/LangGraph (python) driven AI appointment management assistant for the last company I worked for.
The project was scrapped before I had a chance to publish it and see how it deals with real world scenarios.
But I did build the core orchestration, which I had to split up into a pretty complex graph due to having to support pretty limited models like `llama3.2`. It forced me use separate models and deterministic tools for decision making, for structuring document retrieval queries, result assessment and query refinement, for appointment related api calls, and for managing the conversational tone and forming replies (things that pretty much "just worked" with a basic system prompt and list of tools using `gpt-4.1`).

I'm partially using this task as an opportunity to learn more about the ecosystem and infrastructure, which affects some of my choices regarding the tools I use. I'm leaning more towards lower level abstractions that will allow me to build up the toolset myself as opposed to 'batteries-included' frameworks which abstract away a lot of the real-world problems and decision making.

# Setup and instructions

I wanted to make sure the project has minimal requirements and can be run pretty much anywhere, so the only prerequisites are `nodejs >= 26` and `pnpm@12.16.1` (which will be installed automatically if corepack is enabled).

Before running the application, install package dependencies

``` bash
pnpm install
```

The bare chat can be run as a CLI using

``` bash
pnpm chat
```

The web chat experience can be run by starting both the API and web app

``` bash
pnpm api

# - and -

pnpm web
```

# Framework choice

I wanted to go for a relatively barebones solution to have a chance to experience some of the real-world problems that would come up, and find ways to deal with them myself. But I didn't want to build every little thing from scratch either. As a result I ended up building my solution using Vercel's AI SDK which provided me a provider-agnostic, mostly unpinionated solution. Since most of the other tools I considered are either built on top of it or have adapters for it, it gave me the flexibility to use individual components from other libraries if I wanted to.

Some of the alternatives I considered were:

1. LangChain/LangGraph

    I considered LangGraph first because I had some experience with it, and had a general idea of what I'd do if I used it.

    I decided against it because I thought my search workflow would be pretty simple and mostly linear, and using LangGraph felt like having a lot of boilerplate code to use very little of LangGraph's actual capabilities. 
    
2. Mastra

    If I'm completely honest, Mastra seemed like the best solution for this task out of the ones I checked. It had pre-built solutions for every concern and feature I considered. Workflows and subagents, session management and authentication, model context optimization (history compactization and summarization, a rolling window for the last X messages, observational history and user-memories) and it was all much more streamlined and simple to use than LangChain/LangGraph. It would be the quickest to build

    The main reason I decided against it, was for the experience of building the solution and not just following a couple of their recipes for common use-cases.

3. OpenAI's SDK

    I briefly considered OpenAI's SDK. Luna would probably have been trained on it, and it would have small adjustments that would utilize it more optimally. But I didn't want to build a solution that's tightly coupled to a specific vendor/model and I figured the interaction surface between the model and SDK is pretty small and quite similar so it's not worth sacrificing anything else for some potential optimizations it might have.

For the client side, I went with Vercel's AI SDK since they have a core Chat class that takes care of all the SSE plumbing boilerplate without being tied to any specific framework. I wanted to expose both the web chat and an embeddable web-component with shadowDOM, so I didn't want to rely on AI SDK's react+tailwind based components.

At first I thought I'll use just the core Chat class and build my own UI, but to avoid wasting a bunch of time on making a palatable experience (waiting indicators, autofocus and auto-scroll) I decided to use the assistant-ui unstyled primitives and build my own styling.

I went with that because I wanted to put more time and effort into the agentic part rather than on dealing with scrolling and progress indicators.


# Architecture

I wanted to build the project up gradually and focus on the core agentic model, so I went with a modular architecture.

I tried to think of what features that would be relevant to something like Bazak's workflow, which led me to add some core-assumptions/restrictions, and design with certain extra features in mind:

1. First assumption I wanted to go with, is to treat the dummyjson API as a stand-in for a large catalog where products get added and stock amounts change, so I couldn't use any internal knowledge about the products or categories.

2. I thought about how Bazak's website mentions scanning the customer's website and setting everything up, and decided to treat the search limitations of dummyjson's API as a side-effect of a website that has limited functionality, not exposing the catalog properly and only supporting basic text searches in the title and description.

3. Thinking of how such a product would be used, I decided to plan for a couple of extra ways of using the system. In addition to a dedicated shopping assistant web experience (possibly multi-user), I thought that companies would like to embed a shopping assistant experience on their website, which I wanted to implement using a small web-component, but more importantly, the product results should pop up natively in whatever AI potential buyers use personally (ChatGPT, Gemini, Claude, Grok, etc) so I wanted to expose the product search via MCP as well.

`domain` - Anything to do with products and the API calls was abstracted into a domain folder. Since the dummyjson API provides somewhat limited search capabilities, I considered caching results or setting up a local-sync mechanism, and I wanted the underlying retrieval strategy to not affect the rest of the system.

`store` - For anything to do with chats, users, sessions, memories, I wanted to have a pluggable repository. At first I wanted to start with just a few `.json`/`.md` files (kind of like claude-code), but I quickly switched to prefering a DB because I thought it would be useful if I decide to summarize conversations, or sync the product catalog and need either text indexes or vector embeddings. I chose `SQLite` specifically over something like `postgres` because it gave me a zero-install solution that works on any platform without containers or prerequisites, which is perfect for this sort of assignment.

`adapters` - I wanted to focus on the agentic workflow ASAP, so instead of spending time building the API and client before I could do anything, I went with keeping the agentic core and tools in a separate folder with different presentation adapters. I started out with a simple console-only chat. After I refined the search logic and was pretty happy with the results, I added an API layer, and a small MCP wrapper the exposes the product search tool.

`web` - The web-app is a simple React web app that's split into 3 parts:
    - A shared core that handles the chat
    - Components that render the product tiles, sessions, and main app
    - A small single-file app that is used to render product tiles for MCP hosts that support the MCP-app UI extensions (hosts that don't support it, have a markdown fallback that shows the product image and information)

# Retrieval strategy

I thought a lot about what to do with the limited capabilities of the dummyjson api. For instance, one consistent issue I ran into (that ended up unresolved) was that the `tops` category in the catalog is vague and only contains only women's clothing. But the model constantly suggested it to users regardless of gender or purpose.

Throughout the entire process, I considered implementing a full sync background job that would sacrifice some data-freshness but allow me to have a much more robust and feature-rich search experience.
In a real-world scenario I would probably implement some form of background sync that would let me analyze and re-categorize the products, and would allow me to use either a full text index, or even semantic search to look for the products I want. I'd probably only have to verify a small subset of information with the live API to keep rapidly changing information like stock or discounts accurate after performing my search.

I decided against this approach, because it felt like it goes against the spirit of the exercise. I felt like trying to work around the limited API capabilities was part of the intended challenge here.

What I ended up doing, is prefetching only the category stubs on launch to embed them in the system prompt so that the model can have some basic guidelines regarding what's on offer so that it can resolve ambiguous or off-catalog queries, or make suggestions.

To avoid a relentless ping-pong of irrelevant results, I prompted the model to deal with queries that are way too vague by first asking the user for a general direction by offering a couple of the product categories that match their request.

If the user request resolves to something searchable, that's searched directly against the `/products/search` endpoint using the query parameter.

If the user request is a bit more general and matches a category rather than a specific product, I went with the `/products/categories/:categoryId` endpoint and just gave the user some results from the general category.

Off catalog queries are resolved by telling the customer that there is nothing that matches their request, and offering a couple of alternatives from the category list.

For multi-intent queries (or cross-category queries), I decided to perform 1-3 distinct queries and return them in groups instead of one large list of tiles.

Initially, I kept the search logic inside the chat agent's core, giving it access to 3 endpoints as tools:
    - `/products/search` - to search for specific products
    - `/products/categories/:categoryId` - to list products in a category
    - `/products/productId` - a placeholder for when I considered adding a 'product details' expander
That resulted in some clutter in the chat from all the tool calls. So I decided to the search into a seaprate agentic workflow, leaving the assistant chat agent to only deal with managing the user's information, intents, and conversation context.

The final findProducts workflow works the (which is also the one exposed via MCP) following way:

1. It accepts a short one-line query, and an optional price range.
2. It passes the query into a planner that resolves multi-intent queries into separate needs, and for each need, decides whether it requires listing a category/categories or searching for a product/products.
3. The planned queries are executed in parallel in code and the results passed to an availability and price range filter, and an agentic relevance assessment.
4. Queries that have had all their results filtered out (and have more products) attempt to fetch another page of data and pass through phase `3` again.

# Conversation and state

I stored the full conversation state in the DB (SQLite just for this small POC, I'd use something more scalable in a real scenario). I didn't consider cases where the storage is full or corrupted since a DB getting corrupted is much more severe than just an application issue. But I did consider the model's context length.

To avoid overloading the model with irrelevant data, I considered windowing, compactization, summarization, or a mix of all 3. I ended up focusing mostly on windowing because extracting my search into a separate workflow drastically reduces the main chat agent's conversation length. Since shopping sessions tend to not be too long and tend to focus on a couple of things at a time,

I thought that a combination of extracting key memories/insights from the conversation (split between general user info like their age, gender, or preferences; and session related insights like buying a gift for someone else, or what they are interested in) with passing the model just the last N messages will allow it to stay focused on the most relevant topics, while still having a general idea of the larger context, without overloading the context window.

I think that adding some form of summarization would allow the model to better track back-references in a long conversation, but I chose to go with memories and windowing since it's a cheaper (in terms of token usage) approach that's well suited to most shopping scenarios.

# Evaluation

To be completely frank, testing LLMs is something I'm still not that familiar with, so a lot of the test scenarios were authored by claude-code. But I tried to build the application in a way that would keep as much of it as possible deterministic and easily testable.

This way most regressions in my data processing, infrastructure, error handling and API calls, or the search workflow (with mocked models that make predefined decisions) is easy to catch.

To test that the prompts the system uses and the model's decision making I have a set of tests (in `evals`) that are run with a separate command and call the actual model against each scenario several times, considering it a pass if it gives somewhat predictable results 4/5 times.

Those evaluations test for direct and unambiguous requests, for vague requests, for several types of out-of-catalog requests, multi-need requests, missing information (to ensure the model doesn't hallucinate), and for memories being extracted from conversations and used in searches.

Some areas that are difficult to catch (or even assess in the first place) are around vague queries that could be interpreted in different ways. Of course, the model changing could potentially give completely valid results that the tests didn't predict properly, which would also lead to some tests being less reliable than others.

# Known limitations

1. **Search functionality**:
    The search functionality is quite limited at the moment. While combining the model's ability to make inferences and suggestions with the post-processing flow I have, does a pretty good job of dealing with vague requests, or refining results, the lack of ability to do things like filter by price directly against the API, led me to special-casing things like a request for something 'cheaper' in the prompt.

    It was less of a time constraint, and more of an interpretation of the task. But I would create a background sync mechanism that would let me properly analyze the catalog, re-categorize things, and perform more flexible and focused queries. That would improve the result relevance, reduce the task complexity for the model, and result in less API calls.

2. **Session length**:
    I store the entire raw conversation for each session and each user. which is essential for the UI to properly display the conversation, but I probably underutilize the information that's available to me there. I would add a summarization mechanism in addition to my memory/insights mechanism which would at least split the long chat into dedicated 'session' chunk, each with the relevant requests, and information about decisions made or topics discussed. This would help a lot in cases where a user might be browsing to compare several products they are interested in.

3. **Concurrency**:
    To simplify things, I went with a pretty basic model that just rejects concurrent messages to the same chat. It would be much better to queue them up, or allow for some interrupt mechanism (for instance if the model takes to long or if the user makes a mistake). That's something I genuinely wanted to get to, and would do with another week.

4. **User Management**:
    While not strictly required, I have all the data and conversations tied to users, but there's no real authentication. User ids are just passed in a header and trusted. It's more of a placeholder, and it's not important in this sort of POC. But it still bugs me to leave something like that.

5. **Model choide**:
    I completely forgot that the provided API key also works with the Decisions API, I do several different tasks using distinct model 'roles', but I just threw them all at the regular `gpt-6-luna` where I would delegate some of the simpler tasks to a smaller model, and some of the decisions to the decision API and not a generic language model.
