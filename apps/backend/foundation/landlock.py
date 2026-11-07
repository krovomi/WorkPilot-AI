"""Landlock: an unprivileged process narrows what it, and its children, may touch.

Landlock is a Linux security module (kernel 5.13 and later) that needs no
root, no namespace and no setuid helper, so it works inside an ordinary
container where bubblewrap cannot. A process builds a ruleset (the paths it
may read, the paths it may write), restricts itself, then executes the real
program: the restriction holds for that program and everything it starts,
and cannot be lifted.

Two more guarantees come with any Landlock domain: a restricted process
cannot ptrace, or read the ``/proc/<pid>/environ`` of, a process outside its
own domain, and from ABI 6 it cannot signal one either.

Only the standard library is used (``ctypes``): the module is loaded by
``runners/confined_run.py`` right before ``exec``.
"""

from __future__ import annotations

import ctypes
import os
import stat
from collections.abc import Iterable
from dataclasses import dataclass

from foundation.platform import is_linux

# Syscall numbers: the same on every architecture Linux added them to at once.
_SYS_CREATE_RULESET = 444
_SYS_ADD_RULE = 445
_SYS_RESTRICT_SELF = 446

_CREATE_RULESET_VERSION = 1
_RULE_PATH_BENEATH = 1
_PR_SET_NO_NEW_PRIVS = 38

EXECUTE = 1 << 0
WRITE_FILE = 1 << 1
READ_FILE = 1 << 2
READ_DIR = 1 << 3
REMOVE_DIR = 1 << 4
REMOVE_FILE = 1 << 5
MAKE_CHAR = 1 << 6
MAKE_DIR = 1 << 7
MAKE_REG = 1 << 8
MAKE_SOCK = 1 << 9
MAKE_FIFO = 1 << 10
MAKE_BLOCK = 1 << 11
MAKE_SYM = 1 << 12
REFER = 1 << 13  # ABI 2
TRUNCATE = 1 << 14  # ABI 3
IOCTL_DEV = 1 << 15  # ABI 5

SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0  # ABI 6
SCOPE_SIGNAL = 1 << 1  # ABI 6

#: The only rights a rule on a file (not a directory) may carry.
FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV
READ = EXECUTE | READ_FILE | READ_DIR


class LandlockUnavailable(RuntimeError):
    """This kernel, or this platform, cannot enforce a Landlock ruleset."""


@dataclass(frozen=True)
class Rule:
    """A path and what may be done beneath it: ``read`` (read, list, execute),
    ``write`` (everything) or ``list`` (only list directory entries)."""

    path: str
    access: str = "read"


def _libc():
    return ctypes.CDLL(None, use_errno=True)


def abi_version() -> int:
    """The Landlock ABI the kernel speaks; raises when there is none."""
    if not is_linux():
        raise LandlockUnavailable("Landlock exists only on Linux")
    libc = _libc()
    version = libc.syscall(
        _SYS_CREATE_RULESET, None, ctypes.c_size_t(0), _CREATE_RULESET_VERSION
    )
    if version < 0:
        errno = ctypes.get_errno()
        raise LandlockUnavailable(
            f"Landlock is not enabled in this kernel ({os.strerror(errno)})"
        )
    return int(version)


def handled_rights(abi: int) -> int:
    """Every filesystem right this ABI can restrict."""
    rights = (1 << 13) - 1
    if abi >= 2:
        rights |= REFER
    if abi >= 3:
        rights |= TRUNCATE
    if abi >= 5:
        rights |= IOCTL_DEV
    return rights


class _RulesetAttr(ctypes.Structure):
    _fields_ = [
        ("handled_access_fs", ctypes.c_uint64),
        ("handled_access_net", ctypes.c_uint64),
        ("scoped", ctypes.c_uint64),
    ]


class _PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def restrict_self(rules: Iterable[Rule]) -> int:
    """Allow only ``rules`` from now on, for this process and its children.

    Everything not named is denied: reading, writing, executing. Network
    access is left as it is (not handled). Returns the ABI it was enforced
    with. A path that does not exist is skipped; a rule that cannot be added
    raises, because a ruleset missing a rule is not the one asked for.
    """
    abi = abi_version()
    handled = handled_rights(abi)
    libc = _libc()

    attr = _RulesetAttr(handled, 0, 0)
    size = 8
    if abi >= 6:
        attr.scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL
        size = ctypes.sizeof(_RulesetAttr)
    ruleset = libc.syscall(
        _SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(size), 0
    )
    if ruleset < 0:
        raise LandlockUnavailable(
            f"cannot create a ruleset ({os.strerror(ctypes.get_errno())})"
        )
    try:
        for rule in rules:
            try:
                fd = os.open(rule.path, os.O_PATH | os.O_CLOEXEC)
            except FileNotFoundError:
                continue
            try:
                mode = os.fstat(fd).st_mode
                if stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode):
                    # Not a place on the filesystem (`/dev/stdin` leads to a
                    # pipe): nothing to grant there.
                    continue
                is_dir = stat.S_ISDIR(mode)
                rights = {"write": handled, "list": READ_DIR}.get(rule.access, READ)
                if not is_dir:
                    rights &= FILE_RIGHTS
                beneath = _PathBeneathAttr(rights & handled, fd)
                if (
                    libc.syscall(
                        _SYS_ADD_RULE,
                        ruleset,
                        _RULE_PATH_BENEATH,
                        ctypes.byref(beneath),
                        0,
                    )
                    < 0
                ):
                    errno = ctypes.get_errno()
                    raise OSError(
                        errno,
                        f"cannot add a rule for {rule.path}: {os.strerror(errno)}",
                    )
            finally:
                os.close(fd)
        if libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "cannot set no_new_privs")
        if libc.syscall(_SYS_RESTRICT_SELF, ruleset, 0) < 0:
            errno = ctypes.get_errno()
            raise OSError(errno, f"cannot restrict this process: {os.strerror(errno)}")
    finally:
        os.close(ruleset)
    return abi
