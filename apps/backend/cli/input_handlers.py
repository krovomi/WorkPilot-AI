"""
Input Handlers
==============

What the build asks the user to type or load: instructions from a file or
typed over several lines.
"""

from pathlib import Path

from ui import (
    Icons,
    box,
    icon,
    muted,
    print_status,
)


def read_from_file() -> str | None:
    """
    Read text content from a file path provided by the user.

    Returns:
        File contents as string, or None if cancelled/error
    """
    print()
    print(f"{icon(Icons.DOCUMENT)} Enter the path to your file:")
    try:
        file_path_input = input(f"  {icon(Icons.POINTER)} ").strip()
    except (KeyboardInterrupt, EOFError):
        print()
        print_status("Cancelled.", "warning")
        return None

    if not file_path_input:
        print_status("No file path provided.", "warning")
        return None

    try:
        # Expand ~ and resolve path
        file_path = Path(file_path_input).expanduser().resolve()
        if file_path.exists():
            content = file_path.read_text(encoding="utf-8").strip()
            if content:
                print_status(
                    f"Loaded {len(content)} characters from file",
                    "success",
                )
                return content
            else:
                print_status("File is empty.", "error")
                return None
        else:
            print_status(f"File not found: {file_path}", "error")
            return None
    except PermissionError:
        print_status(f"Permission denied: cannot read {file_path_input}", "error")
        return None
    except (OSError, UnicodeDecodeError) as e:
        print_status(f"Error reading file: {e}", "error")
        return None


def read_multiline_input(prompt_text: str) -> str | None:
    """
    Read multi-line input from the user.

    Args:
        prompt_text: Text to display in the prompt box

    Returns:
        User input as string, or None if cancelled
    """
    print()
    content = [
        prompt_text,
        muted("Press Enter on an empty line when done."),
    ]
    print(box(content, width=60, style="light"))
    print()

    lines = []
    while True:
        try:
            line = input()
            if line == "":  # an empty line ends the input
                break
            lines.append(line)
        except KeyboardInterrupt:
            print()
            print_status("Cancelled.", "warning")
            return None
        except EOFError:
            break

    return "\n".join(lines).strip()
