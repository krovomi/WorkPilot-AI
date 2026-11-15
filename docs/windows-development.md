# Windows Development Guide

This guide covers Windows-specific considerations when developing
WorkPilot AI.

## File Encoding

### Problem

Windows Python defaults to the `cp1252` (Windows-1252) code page instead
of UTF-8. This causes encoding errors when reading/writing files with
non-ASCII characters.

**Common Error:**

```plaintext
UnicodeDecodeError: 'charmap' codec can't decode byte 0x8d in position 1234
```

### Solution

**Always specify `encoding="utf-8"` for all text file operations.**

See [CONTRIBUTING.md - File Encoding](CONTRIBUTING.md#file-encoding-python)
for detailed examples and patterns.

### Testing on Windows

To verify your code works on Windows:

1. **Test with non-ASCII content:**

   ```python
   # Include emoji, international chars in test data
   test_data = {"message": "Test 🚀 with ñoño and 中文"}
   ```

2. **Run pre-commit hooks:**

   ```bash
   pre-commit run check-file-encoding --all-files
   ```

3. **Run all tests:**

   ```bash
   npm run test:backend
   ```

### Common Pitfalls

#### Pitfall 1: JSON files

```python
# Wrong - no encoding
with open("config.json") as f:
    data = json.load(f)

# Correct
with open("config.json", encoding="utf-8") as f:
    data = json.load(f)
```

#### Pitfall 2: Path methods

```python
# Wrong
content = Path("README.md").read_text()

# Correct
content = Path("README.md").read_text(encoding="utf-8")
```

#### Pitfall 3: Subprocess output

```python
# Wrong
result = subprocess.run(cmd, capture_output=True, text=True)

# Correct
result = subprocess.run(cmd, capture_output=True, encoding="utf-8")
```

## Line Endings

### Problem

Windows uses CRLF (`\r\n`) line endings while macOS/Linux use LF (`\n`).
This can cause git diffs to show every line as changed.

### Solution

1. **Configure git to handle line endings:**

   ```bash
   git config --global core.autocrlf true
   ```

2. **The project's `.gitattributes` handles this automatically:**

   ```plaintext
   * text=auto
   *.py text eol=lf
   *.md text eol=lf
   ```

3. **In code, normalize when processing:**

   ```python
   # Normalize line endings to LF (idiomatic approach)
   content = "\n".join(content.splitlines())
   ```

## What a Linux run does not see

A session in a Linux container can have every suite green and still turn the
Windows CI red; pytest runs there with `-x`, so each shard shows only its first
failure. Seven traps keep coming back, and three are held on Linux too:

| Trap on Windows | What holds it on Linux |
|---|---|
| a path made by `str(p.relative_to(root))`, `str(Path(...))` or `os.path.relpath` holds `\` in a report, an event, a prompt or a test | `python scripts/quality_baselines.py check` (per-file ceiling `native-path`): write `.as_posix()` |
| a runner started by a test dies on an emoji (`cp1252` console) | `tests/conftest.py` gives every test the app's `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` |
| `open` / `read_text` / `write_text` without an encoding | `tests/test_text_io_encoding.py` |
| a tool started by its bare name (`["claude", ...]`) when it is an npm `.cmd` shim: Windows only looks for `claude.exe` | nothing: start the path `shutil.which` (or `foundation.platform.find_executable`) returned, and pass a minimal env with `SYSTEMROOT` |
| `write_text("x\n")` writes `\r\n`; a text pipe (`text=True`) changes a patch's line endings; an OS error (`str(exc)`) has other words | nothing: write in bytes what must be bytes (`write_bytes`, `git diff --output=<file>`), and word yourself the message a test reads |
| `time.time()` moves in ~16 ms steps: two records written one after the other carry the same time, and "newest first" falls back to another order | nothing: never order by a timestamp alone; make the next one strictly greater (`generational_tests/archive.py`) or add a sequence |
| `os.replace` over a file another handle holds for an instant (a reader, the indexer, an antivirus) raises `PermissionError [WinError 5]`, lock or no lock | nothing: write through `foundation.file_utils` (`atomic_write`, `write_json_atomic`, `replace_file`), which waits it out on Windows |

## Path Separators

### Problem

Windows uses backslash `\` for paths, while Unix uses `/`.
This can break path operations.

### Solution

1. **Always use `Path` from `pathlib`:**

   ```python
   from pathlib import Path

   # Correct - works on all platforms
   config_path = Path("config") / "settings.json"

   # Wrong - Unix only
   config_path = "config/settings.json"
   ```

1b. **A path that leaves the process is POSIX:** in a report, an event, a
   prompt, a JSON file or a test, write `path.relative_to(root).as_posix()`,
   never `str(path.relative_to(root))`: on Windows the second one is
   `src\a.cs`. `python scripts/quality_baselines.py check` refuses a new
   `str(...relative_to(...))`, `str(Path(...))` or `os.path.relpath(...)`
   (ceiling per file in `tests/baselines/native-path.json`).

2. **Use `os.path.join()` for strings:**

   ```python
   import os

   # Correct
   config_path = os.path.join("config", "settings.json")
   ```

3. **Never hardcode separators:**

   ```python
   # Wrong - Unix only
   path = "apps/backend/core"

   # Correct
   path = os.path.join("apps", "backend", "core")
   # Or better
   path = Path("apps") / "backend" / "core"
   ```

## Shell Commands

### Problem

Windows doesn't have bash by default. Shell commands need to work across
platforms.

### Solution

1. **Use Python libraries instead of shell:**

   ```python
   # Instead of shell commands
   import shutil

   shutil.copy("source.txt", "dest.txt")  # Instead of cp

   import os

   os.remove("file.txt")  # Instead of rm
   ```

2. **Use `shlex` for cross-platform commands:**

   ```python
   import shlex
   import subprocess

   cmd = shlex.split("git rev-parse HEAD")
   result = subprocess.run(cmd, capture_output=True, encoding="utf-8")
   ```

3. **Check platform when needed:**

   ```python
   import sys

   if sys.platform == "win32":
       # Windows-specific code
       pass
   else:
       # Unix code
       pass
   ```

## Development Environment

### Recommended Setup on Windows

1. **Use WSL2 (Windows Subsystem for Linux)** - Recommended:
   - Most consistent with production Linux environment
   - Full bash support
   - Better performance for file I/O
   - Install from Microsoft Store or: `wsl --install`

2. **Or use Git Bash:**
   - Comes with Git for Windows
   - Provides Unix-like shell
   - Lighter than WSL
   - Download from [gitforwindows.org](https://gitforwindows.org/)

3. **Or use PowerShell with Python:**
   - Native Windows environment
   - Requires extra care with paths/encoding
   - Built into Windows

### Editor Configuration

**VS Code settings for Windows (`settings.json`):**

```json
{
  "files.encoding": "utf8",
  "files.eol": "\n",
  "python.analysis.typeCheckingMode": "basic",
  "editor.formatOnSave": true
}
```

## Common Issues and Solutions

### Issue: Permission errors when deleting files

**Problem:** Windows file locking is stricter than Unix.

**Solution:** Ensure files are properly closed using context managers:

```python
# Use context managers
with open(path, encoding="utf-8") as f:
    data = f.read()
# File is closed here - safe to delete
```

### Issue: Long path names

**Problem:** Windows has a 260-character path limit (legacy).

**Solution:**

1. Enable long paths in Windows 10+ (Group Policy or Registry)
2. Or keep paths short
3. Or use WSL2

### Issue: Case-insensitive filesystem

**Problem:** Windows filesystem is case-insensitive
(`File.txt` == `file.txt`).

**Solution:** Be consistent with casing in filenames and imports:

```python
# Consistent casing
from apps.backend.core import Client  # File: client.py

# Avoid mixing cases
from apps.backend.core import client  # Could work on Windows but fail on Linux
```

## Testing Windows Compatibility

### Before Submitting a PR

1. **Run pre-commit hooks:**

   ```bash
   pre-commit run --all-files
   ```

2. **Run all tests:**

   ```bash
   npm run test:backend
   npm test  # frontend tests
   ```

3. **Test with special characters:**

   ```python
   # Add test data with emoji, international chars
   test_content = "Test 🚀 ñoño 中文 العربية"
   ```

### Windows-Specific Test Cases

Add tests for Windows compatibility when relevant:

```python
import sys
import pytest


@pytest.mark.skipif(sys.platform != "win32", reason="Windows only")
def test_windows_encoding():
    """Test Windows encoding with special characters."""
    content = "Test 🚀 ñoño 中文"
    Path("test.txt").write_text(content, encoding="utf-8")
    loaded = Path("test.txt").read_text(encoding="utf-8")
    assert loaded == content
```

## Getting Help

If you encounter Windows-specific issues:

1. Check this guide and [CONTRIBUTING.md](CONTRIBUTING.md)
2. Search [existing issues](https://github.com/krovomi/WorkPilot-AI/issues)
3. Ask in [discussions](https://github.com/krovomi/WorkPilot-AI/discussions)
4. Create an issue with `[Windows]` tag

## Resources

- [Python on Windows](https://docs.python.org/3/using/windows.html)
- [pathlib Documentation](https://docs.python.org/3/library/pathlib.html)
- [Git for Windows](https://gitforwindows.org/)
- [WSL2 Documentation](https://docs.microsoft.com/en-us/windows/wsl/)

## Related

- [CONTRIBUTING.md](CONTRIBUTING.md) - General contribution
  guidelines
- The UTF-8 encoding rules this guide describes are enforced by the
  pre-commit hooks; see [CONTRIBUTING.md](CONTRIBUTING.md)
