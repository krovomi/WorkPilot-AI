"""Tests for the encoding check script."""

# Import the checker
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from check_encoding import EncodingChecker


class TestEncodingChecker:
    """Test the EncodingChecker class."""

    def test_detects_open_without_encoding(self):
        """Should detect open() calls without encoding parameter."""
        code = """
def read_file(path):
    with open(path) as f:
        return f.read()
"""
        # Create temp file
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is False
            assert len(checker.issues) == 1
            assert "open() without encoding" in checker.issues[0]
        finally:
            temp_path.unlink()

    def test_allows_open_with_encoding(self):
        """Should allow open() calls with encoding parameter."""
        code = """
def read_file(path):
    with open(path, encoding="utf-8") as f:
        return f.read()
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_allows_binary_mode_without_encoding(self):
        """Should allow binary mode without encoding (correct behavior)."""
        code = """
def read_file(path):
    with open(path, "rb") as f:
        return f.read()
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_allows_write_binary_mode_without_encoding(self):
        """Should allow write binary mode (wb) without encoding."""
        code = """
def write_file(path, data):
    with open(path, "wb") as f:
        f.write(data)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_allows_append_binary_mode_without_encoding(self):
        """Should allow append binary mode (ab) without encoding."""
        code = """
def append_file(path, data):
    with open(path, "ab") as f:
        f.write(data)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_detects_text_write_mode_without_encoding(self):
        """Should detect text write mode (w) without encoding."""
        code = """
def write_file(path, content):
    with open(path, "w") as f:
        f.write(content)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is False
            assert len(checker.issues) == 1
            assert "open() without encoding" in checker.issues[0]
        finally:
            temp_path.unlink()

    def test_detects_path_read_text_without_encoding(self):
        """Should detect Path.read_text() without encoding."""
        code = """
from pathlib import Path

def read_file(path):
    return Path(path).read_text()
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is False
            assert len(checker.issues) == 1
            assert "read_text() without encoding" in checker.issues[0]
        finally:
            temp_path.unlink()

    def test_detects_path_write_text_without_encoding(self):
        """Should detect Path.write_text() without encoding."""
        code = """
from pathlib import Path

def write_file(path, content):
    Path(path).write_text(content)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is False
            assert len(checker.issues) == 1
            assert "write_text() without encoding" in checker.issues[0]
        finally:
            temp_path.unlink()

    def test_detects_json_load_without_encoding(self):
        """Should detect json.load(open()) without encoding in open()."""
        code = """
import json

def read_json(path):
    with open(path) as f:
        return json.load(f)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is False
            assert len(checker.issues) == 1
            # Detects the open() call without encoding
        finally:
            temp_path.unlink()

    def test_allows_path_read_text_with_encoding(self):
        """Should allow Path.read_text() with encoding parameter."""
        code = """
from pathlib import Path

def read_file(path):
    return Path(path).read_text(encoding="utf-8")
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_allows_path_write_text_with_encoding(self):
        """Should allow Path.write_text() with encoding parameter."""
        code = """
from pathlib import Path

def write_file(path, content):
    Path(path).write_text(content, encoding="utf-8")
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_allows_json_dump_with_encoding(self):
        """Should allow json.dump() with encoding in open()."""
        code = """
import json

def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_detects_json_dump_without_encoding(self):
        """Should detect json.dump() with open() without encoding."""
        code = """
import json

def write_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is False
            assert len(checker.issues) == 1
            # Detects the open() call without encoding
        finally:
            temp_path.unlink()

    def test_multiple_issues_in_single_file(self):
        """Should detect multiple encoding issues in a single file."""
        code = """
from pathlib import Path

def process_files(input_path, output_path):
    # Missing encoding in open()
    with open(input_path) as f:
        content = f.read()

    # Missing encoding in Path.write_text()
    Path(output_path).write_text(content)

    return content
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is False
            assert len(checker.issues) == 2
        finally:
            temp_path.unlink()

    def test_skips_non_python_files(self):
        """Should skip files that are not Python files."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, encoding="utf-8"
        ) as f:
            f.write("with open(path) as f: pass")
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            failed_count = checker.check_files([temp_path])

            assert failed_count == 0
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_allows_nested_call_in_open_arguments(self):
        """A nested call must not truncate the argument list.

        `open\\s*\\([^)]+\\)` stopped at the first `)` — inside `join(d, "f")` —
        so it never saw the `encoding=` that came after, and reported a call
        that was already correct.
        """
        code = """
import os

def write_report(directory, body):
    with open(os.path.join(directory, "report.txt"), "w", encoding="utf-8") as f:
        f.write(body)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True, checker.issues
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_ignores_calls_quoted_in_comments_and_strings(self):
        """Only real code counts: a call named in prose is not a call."""
        code = '''
FIXTURE = """
with open(path) as f:
    pass
"""

def documented():
    # Missing encoding in open() — this sentence is not a call site
    return FIXTURE
'''
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True, checker.issues
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_ignores_calls_quoted_inside_an_f_string(self):
        """An f-string is text too, on every Python the project supports.

        PEP 701 (3.12) split f-strings into FSTRING_START/MIDDLE/END, so the
        literal text stopped arriving as a STRING token. Masking only STRING
        left `f"… open() …"` visible as code, and `check_encoding.py` — whose
        own messages name `open()` — reported itself. It passed on 3.11 and
        failed on 3.12 and 3.13, which is the split this pins.
        """
        code = """
def report(path, line):
    return f"{path}:{line} - json.load(open()) without encoding in open()"
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True, checker.issues
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_still_reads_replacement_fields_as_code(self):
        """Masking an f-string's text must not blind the scan to its `{…}`.

        The guard here is against over-correcting: masking the whole f-string
        span would silence the version-split above, and quietly stop the
        checker from seeing a real call inside a replacement field.

        What the field resolves to is version-dependent, so this asserts what
        the running Python can actually see. Before PEP 701 the f-string is one
        STRING token and the field is masked with the rest of it — a known
        limitation of the pre-3.12 path, and below the project's own 3.12 floor.
        """
        import tokenize

        code = """
def load(path):
    return f"{open(path).read()}"
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            if hasattr(tokenize, "FSTRING_MIDDLE"):
                assert result is False
                assert len(checker.issues) == 1
                assert "open() without encoding" in checker.issues[0]
            else:
                assert result is True, checker.issues
        finally:
            temp_path.unlink()

    def test_allows_positional_encoding_on_path_helpers(self):
        """`read_text(encoding, …)` and `write_text(data, encoding, …)`.

        Both accept the encoding positionally, so `p.read_text("utf-8")` does
        declare one. Looking only for `encoding=` flagged these, and the only
        way to silence the hook was to rewrite correct code.
        """
        code = """
from pathlib import Path

def roundtrip(path, payload):
    Path(path).write_text(payload, "utf-8")
    return Path(path).read_text("utf-8")
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is True, checker.issues
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()

    def test_positional_data_alone_is_still_missing_encoding(self):
        """`write_text(data)` has one positional argument, not two."""
        code = """
from pathlib import Path

def save(path, payload):
    Path(path).write_text(payload)
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            assert result is False
            assert len(checker.issues) == 1
            assert ".write_text() without encoding" in checker.issues[0]
        finally:
            temp_path.unlink()

    def test_detects_encoding_with_spaces(self):
        """Should detect encoding parameter even with spaces around equals sign."""
        code = """
def read_file(path):
    # This has spaces: encoding = "utf-8"
    with open(path, encoding = "utf-8") as f:
        return f.read()
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        try:
            checker = EncodingChecker()
            result = checker.check_file(temp_path)

            # Should pass because word boundary regex handles spaces
            assert result is True
            assert len(checker.issues) == 0
        finally:
            temp_path.unlink()
