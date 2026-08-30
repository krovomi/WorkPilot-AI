#!/usr/bin/env python3
"""
Check File Encoding
===================

Pre-commit hook to ensure all file operations specify UTF-8 encoding.

This prevents Windows encoding issues where Python defaults to cp1252 instead of UTF-8.
"""

import argparse
import re
import sys
from pathlib import Path

# Fix Windows console encoding for emoji output
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        # Python < 3.7
        import codecs

        sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, "strict")


def _code_only(content: str) -> str:
    """
    Le fichier avec ses commentaires et ses litteraux remplaces par des espaces.

    Les offsets et les numeros de ligne sont preserves, si bien que tout ce qui
    scanne ce texte rapporte les memes positions que sur l'original — mais ne
    voit plus que du code.

    Sans cela, un `open()` cite dans un commentaire (`# Missing encoding in
    open()`) ou dans une chaine de test etait signale comme un vrai appel.

    Ce texte sert a *reperer* les appels, jamais a les lire : le mode binaire
    d'un `open(path, "wb")` vit dans un litteral, donc dans ce qui est masque.
    Les arguments sont relus sur l'original, a la position trouvee ici.

    Sur un fichier que `tokenize` refuse (syntaxe invalide), on rend le contenu
    tel quel : mieux vaut un faux positif qu'un fichier non verifie.
    """
    import io
    import tokenize

    masked = list(content)
    lines = content.splitlines(keepends=True)
    starts = []
    acc = 0
    for line in lines:
        starts.append(acc)
        acc += len(line)

    def offset(row: int, col: int) -> int:
        return starts[row - 1] + col if 0 < row <= len(starts) else len(content)

    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(content).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return content

    for tok in tokens:
        if tok.type not in (tokenize.COMMENT, tokenize.STRING):
            continue
        begin, end = offset(*tok.start), offset(*tok.end)
        for i in range(begin, min(end, len(masked))):
            if masked[i] != "\n":
                masked[i] = " "
    return "".join(masked)


def _call_source(content: str, start: int, open_paren: int) -> str | None:
    """
    Le texte d'un appel, de `start` jusqu'a la parenthese appariee.

    Les parentheses sont equilibrees et les chaines ignorees, pour qu'un appel
    imbrique (`open(os.path.join(d, "f"), "w", encoding="utf-8")`) ou une
    parenthese dans un litteral ne tronquent pas la lecture.
    """
    depth, i, quote = 0, open_paren, None
    while i < len(content):
        ch = content[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if content.startswith(quote, i):
                i += len(quote)
                quote = None
                continue
            i += 1
            continue
        if content.startswith(('"""', "'''"), i):
            quote = content[i : i + 3]
            i += 3
            continue
        if ch in "\"'":
            quote = ch
            i += 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return content[start : i + 1]
        i += 1
    return None


def _positional_args(args_src: str) -> int:
    """
    Le nombre d'arguments positionnels d'une liste d'arguments.

    Le decoupage se fait sur les virgules de premier niveau, hors chaines et
    hors parentheses/crochets/accolades, et s'arrete au premier mot-cle : dans
    `write_text(json.dumps(d), "utf-8")` il y a deux positionnels, pas trois.
    """
    depth, quote, count, current = 0, None, 0, ""
    i = 0
    segments = []
    while i < len(args_src):
        ch = args_src[i]
        if quote:
            if ch == "\\":
                current += args_src[i : i + 2]
                i += 2
                continue
            if args_src.startswith(quote, i):
                current += quote
                i += len(quote)
                quote = None
                continue
            current += ch
            i += 1
            continue
        if args_src.startswith(('"""', "'''"), i):
            quote = args_src[i : i + 3]
            current += quote
            i += 3
            continue
        if ch in "\"'":
            quote = ch
            current += ch
            i += 1
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            segments.append(current)
            current = ""
            i += 1
            continue
        current += ch
        i += 1
    if current.strip():
        segments.append(current)

    for segment in segments:
        if re.match(r"\s*\w+\s*=[^=]", segment):
            break  # premier mot-cle : tout ce qui suit est nomme
        count += 1
    return count


def _encoding_is_positional(args_src: str, slot: int) -> bool:
    """
    Vrai si `encoding` est passe positionnellement, a l'index `slot`.

    `Path.read_text(encoding, errors, newline)` accepte l'encodage en premier
    argument, `write_text(data, encoding, …)` en deuxieme : `p.read_text("utf-8")`
    declare bien son encodage, meme sans le nommer. Ne chercher que `encoding=`
    signalait ces appels comme fautifs, et la seule facon de faire taire le hook
    etait de reecrire du code deja correct.
    """
    return _positional_args(args_src) > slot


class EncodingChecker:
    """Checks Python files for missing UTF-8 encoding parameters."""

    def __init__(self):
        self.issues = []

    def check_file(self, filepath: Path) -> bool:
        """
        Check a single Python file for encoding issues.

        Returns:
            True if file passes checks, False if issues found
        """
        try:
            content = filepath.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            self.issues.append(f"{filepath}: File is not UTF-8 encoded")
            return False
        except OSError as e:
            self.issues.append(f"{filepath}: Cannot read file ({e})")
            return False

        file_issues = []

        # Les cinq motifs ci-dessous sont cherches dans `scan`, ou commentaires
        # et litteraux sont blanchis, et relus dans `content`. Chercher dans le
        # fichier brut signalait le `open()` d'une phrase de commentaire ou d'une
        # fixture de test ; lire dans le texte blanchi ferait disparaitre le mode
        # `"wb"` qui exempte les ouvertures binaires. Les offsets etant les memes
        # des deux cotes, une position trouvee dans l'un s'utilise dans l'autre.
        scan = _code_only(content)

        # Check 1: open() without encoding
        # Pattern: open(..., encoding="utf-8") without encoding= parameter
        # Use negative lookbehind to exclude os.open(), urlopen(), etc.
        #
        # The argument list is delimited by balancing parentheses, not by the
        # first `)`. A pattern like `open\s*\([^)]+\)` stops inside a nested
        # call — `open(os.path.join(d, "f"), "w", encoding="utf-8")` matched
        # only up to `join(d, "f")`, saw no `encoding=`, and reported a file
        # that was already correct. Nesting is common enough that the false
        # positives outnumbered the real findings in `tests/`. Check 2 below
        # has always balanced properly; this one had not caught up.
        for match in re.finditer(r"(?<![a-zA-Z_\.])open\s*\(", scan):
            call = _call_source(
                content, match.start(), content.index("(", match.start())
            )
            if call is None:
                continue

            # Skip if it's binary mode (must contain 'b' in mode string)
            # Matches: "rb", "wb", "ab", "r+b", "w+b", etc.
            if re.search(r'["\'][rwax+]*b[rwax+]*["\']', call):
                continue

            # Skip if it already has encoding (use word boundary for robustness)
            if re.search(r"\bencoding\s*=", call):
                continue

            # open(file, mode, buffering, encoding, …) : quatrieme positionnel
            if _encoding_is_positional(call[call.index("(") + 1 : -1], 3):
                continue

            # Get line number
            line_num = content[: match.start()].count("\n") + 1
            file_issues.append(
                f"{filepath}:{line_num} - open() without encoding parameter"
            )

        # Check 2: Path.read_text() without encoding
        # Match .read_text(encoding="utf-8") calls - both variable.read_text(encoding="utf-8") and Path(...).read_text(encoding="utf-8")
        for match in re.finditer(r"(?:(\w+)|(\))\s*)\.read_text\s*\(", scan):
            var_name = match.group(1)  # Will be None if matched closing paren
            start_pos = match.end()

            # Find the matching closing parenthesis (handle nesting)
            paren_depth = 1
            end_pos = start_pos
            while end_pos < len(content) and paren_depth > 0:
                if content[end_pos] == "(":
                    paren_depth += 1
                elif content[end_pos] == ")":
                    paren_depth -= 1
                end_pos += 1
            args = content[start_pos : end_pos - 1] if end_pos > start_pos else ""

            # Skip if it already has encoding
            if re.search(r"\bencoding\s*=", args):
                continue

            # read_text(encoding, errors, newline) : premier positionnel
            if _encoding_is_positional(args, 0):
                continue

            # Skip method calls on self/cls (custom methods, not Path)
            if var_name in ("self", "cls"):
                continue

            # Skip if var_name is 'Path' (class name reference, not instance call)
            if var_name == "Path":
                continue

            # Skip if it's a custom method call (e.g., self.parser.read_text)
            # Check the characters immediately before the matched variable name
            if var_name:
                prefix_start = max(0, match.start() - 10)
                prefix = content[prefix_start : match.start()]
                if re.search(r"\bself\.$", prefix) or re.search(r"\bcls\.$", prefix):
                    continue

            line_num = content[: match.start()].count("\n") + 1
            file_issues.append(
                f"{filepath}:{line_num} - .read_text() without encoding parameter"
            )

        # Check 3: Path.write_text() without encoding
        # Match .write_text(encoding="utf-8") calls - both variable.write_text(encoding="utf-8") and Path(...).write_text(encoding="utf-8")
        for match in re.finditer(r"(?:(\w+)|(\))\s*)\.write_text\s*\(", scan):
            var_name = match.group(1)  # Will be None if matched closing paren
            start_pos = match.end()

            # Find the matching closing parenthesis (handle nesting)
            paren_depth = 1
            end_pos = start_pos
            while end_pos < len(content) and paren_depth > 0:
                if content[end_pos] == "(":
                    paren_depth += 1
                elif content[end_pos] == ")":
                    paren_depth -= 1
                end_pos += 1
            args = content[start_pos : end_pos - 1] if end_pos > start_pos else ""

            # Skip if it already has encoding
            if re.search(r"\bencoding\s*=", args):
                continue

            # write_text(data, encoding, errors, newline) : deuxieme positionnel
            if _encoding_is_positional(args, 1):
                continue

            # Skip method calls on self/cls (custom methods, not Path)
            if var_name in ("self", "cls"):
                continue

            # Skip if var_name is 'Path' (class name reference, not instance call)
            if var_name == "Path":
                continue

            # Skip if it's a custom method call (e.g., self.parser.write_text)
            # Check the characters immediately before the matched variable name
            if var_name:
                prefix_start = max(0, match.start() - 10)
                prefix = content[prefix_start : match.start()]
                if re.search(r"\bself\.$", prefix) or re.search(r"\bcls\.$", prefix):
                    continue

            line_num = content[: match.start()].count("\n") + 1
            file_issues.append(
                f"{filepath}:{line_num} - .write_text() without encoding parameter"
            )

        # Check 4: json.load() with open() without encoding
        for match in re.finditer(r"json\.load\s*\(\s*open\s*\([^)]+\)", scan):
            call = content[match.start() : match.end()]

            # Skip if open() has encoding (use word boundary for robustness)
            if re.search(r"\bencoding\s*=", call):
                continue

            line_num = content[: match.start()].count("\n") + 1
            file_issues.append(
                f"{filepath}:{line_num} - json.load(open()) without encoding in open()"
            )

        # Check 5: json.dump() with open() without encoding
        for match in re.finditer(r"json\.dump\s*\([^,]+,\s*open\s*\([^)]+\)", scan):
            call = content[match.start() : match.end()]

            # Skip if open() has encoding (use word boundary for robustness)
            if re.search(r"\bencoding\s*=", call):
                continue

            line_num = content[: match.start()].count("\n") + 1
            file_issues.append(
                f"{filepath}:{line_num} - json.dump(..., open()) without encoding in open()"
            )

        self.issues.extend(file_issues)
        return len(file_issues) == 0

    def check_files(self, filepaths: list[Path]) -> int:
        """
        Check multiple files.

        Returns:
            Number of files with issues
        """
        for filepath in filepaths:
            if not filepath.exists():
                continue

            if not filepath.suffix == ".py":
                continue

            self.check_file(filepath)

        return len([f for f in self.issues if f])


def main():
    """Main entry point for pre-commit hook."""
    parser = argparse.ArgumentParser(
        description="Check Python files for missing UTF-8 encoding parameters"
    )
    parser.add_argument("filenames", nargs="*", help="Filenames to check")
    parser.add_argument("--verbose", action="store_true", help="Show all issues found")

    args = parser.parse_args()

    # Convert filenames to Path objects
    files = [Path(f) for f in args.filenames]

    # Run checks
    checker = EncodingChecker()
    checker.check_files(files)

    # Report results
    if checker.issues:
        print("❌ Encoding issues found:")
        print()
        for issue in checker.issues:
            print(f"  {issue}")
        print()
        print('💡 Fix: Add encoding="utf-8" parameter to file operations')
        print()
        print("Examples:")
        print('  open(path, encoding="utf-8")')
        print('  Path(file).read_text(encoding="utf-8")')
        print('  Path(file).write_text(content, encoding="utf-8")')
        print()
        return 1

    if args.verbose:
        print(f"✅ All {len(files)} files pass encoding checks")

    return 0


if __name__ == "__main__":
    sys.exit(main())
