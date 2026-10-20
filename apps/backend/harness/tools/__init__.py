"""The tools the harness serves to models, on both halves of the product.

Each tool is written once, in ``harness.application``, and reached two ways, as
the brain's are: over MCP by the loops a SDK or a CLI holds (Claude Code, and
any agent a person attaches the server to), and in-process through
`core.runtimes.tool_executor` by the loops WorkPilot holds (OpenAI and the
compatible providers, Ollama/LM Studio, Copilot, Windsurf).
"""
