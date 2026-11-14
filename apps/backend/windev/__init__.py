"""WinDev, WebDev and WinDev Mobile projects (PC SOFT, WLangage).

What an agent can do on such a project depends on how its elements are saved
(``files``): in the text format the WLangage code is readable and editable in
``code`` blocks (``text_format``), in the native format nothing is. The
package detects the project (``project``), says what agents may and may not
write (``prompt``, with the bundled skills staged by ``skills``) and checks
afterwards that only code changed (``integrity``). It runs no agent and
imports nothing from the rest of the backend.

Design and limits: docs/architecture/windev.md.
"""

from .files import file_format, is_windev_path, sniff_format
from .integrity import FileChange, IntegrityReport, Problem, check_changes
from .project import WinDevProject, detect_project, find_project_files
from .prompt import windev_section
from .text_format import CodeBlock, TextElement, parse_text_element

__all__ = [
    "CodeBlock",
    "FileChange",
    "IntegrityReport",
    "Problem",
    "TextElement",
    "WinDevProject",
    "check_changes",
    "detect_project",
    "file_format",
    "find_project_files",
    "is_windev_path",
    "parse_text_element",
    "sniff_format",
    "windev_section",
]
