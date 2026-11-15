# AI Resolver

Resolves a merge conflict the deterministic strategies cannot, by asking a model
for the merged code at the conflict's location.

```
ai_resolver/
├── __init__.py        # AIResolver, ConflictContext, create_ai_resolver
├── resolver.py        # AIResolver: context, prompt, answer → MergeResult
├── context.py         # ConflictContext: the minimal context sent to the model
├── prompts.py         # system prompt and merge prompt
├── parsers.py         # the code of a fenced block in the answer
├── language_utils.py  # file language; which locations meet
└── client.py          # create_ai_resolver: asks the user's provider
```

## The model is the user's

`create_ai_resolver(project_dir)` sends the question through the one-shot
completion of the `agent_runtime` port, so it goes to the provider the user
chose (Claude, Copilot, OpenAI, a local model…), with no Claude token needed
for the others. Without a runtime the resolver has no model, and every conflict
goes to review.

## What counts as an answer

The answer is written into the project file, so only the code of a fenced block
counts, never its language tag. The block in the file's language wins; else the
first block. An answer without a block (an explanation, an empty reply) sends the
conflict to review, as do a context over `max_context_tokens` and a missing model;
a model that raises fails the conflict.

Only the changes of the involved tasks at the conflict's location (or a member of
it: `class:A` and `class:A.b`) reach the prompt.

```python
from merge.ai_resolver import create_ai_resolver

resolver = create_ai_resolver(project_dir)
result = resolver.resolve_conflict(conflict, baseline_code, task_snapshots)
```
