# Methodology

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

# Background

I don't have much of a background with AI driven systems. And I'm not a huge LLM user personally. I only started using `claude-code` after taking a year off work in 2026, specifically to practice and learn to use it and I don't use any other LLMs for non software-related goals.

My main relevant experience is designing a prototype for a LangChain/LangGraph (python) driven AI appointment management assistant for the last company I worked for.
The project was scrapped before I had a chance to publish it and see how it deals with real world scenarios.
But I did build the core orchestration, which I had to split up into a pretty complex graph due to having to support pretty limited models like `llama3.2`. It forced me use separate models and deterministic tools for decision making, for structuring document retrieval queries, result assessment and query refinement, for appointment related api calls, and for managing the conversational tone and forming replies (things that pretty much "just worked" with a basic system prompt and list of tools using `gpt-4.1`).

I'm partially using this task as an opportunity to learn more about the ecosystem and infrastructure, which affects some of my choices regarding the tools I use. I'm leaning more towards lower level abstractions that will allow me to build up the toolset myself as opposed to 'batteries-included' frameworks which abstract away a lot of the real-world problems and decision making.
