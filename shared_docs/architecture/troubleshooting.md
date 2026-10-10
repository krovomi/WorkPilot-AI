# Troubleshooting

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Common Issues

**Claude Authentication Problems:**
```bash
# Check profile configuration
cat ~/.claude/profiles.json
# Refresh tokens automatically via UI or:
python -c "from main.claude_profile.token_refresh import refresh_all_tokens; refresh_all_tokens()"
```

**Build Issues Cross-Platform:**
```bash
# Use platform abstraction functions
from core.platform import isWindows, findExecutable, joinPaths

# Never hardcode paths
exe_path = findExecutable("node")  # Works on Win/Mac/Linux
full_path = joinPaths(["src", "components"])  # OS-agnostic
```

**grepai Connection Issues:**
```bash
# Check if grepai is running
curl http://localhost:9000/health
# Start grepai if needed
cd src/connectors/grepai && python grepai_launcher.py
```

**Memory System Issues:**
```bash
# Where is the shared brain, and what does it hold?
python apps/backend/runners/brain_runner.py --action status
# Import what builds learned before the vault was the one memory
python apps/backend/runners/brain_runner.py --action import-legacy --project-dir .
# Memory is on unless BRAIN_ENABLED=false
```

**Performance Issues:**
- Monitor workflow logs: `tail -f logs/workflow.log`
- Reduce concurrent agents in settings

## Getting Help

- Check `logs/workflow.log` for detailed execution traces
- Run `pytest tests/ -v` from the backend venv for test failures
- Check [shared_docs/README.md](../README.md) for system design
