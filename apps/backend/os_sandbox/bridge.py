"""Inside a Linux sandbox: the loopback door to the filtering proxy.

The sandbox has a network namespace of its own, with only ``lo``. The proxy
lives outside, on a Unix socket that the sandbox binds in. This script,
started by ``bwrap`` with the standard library only (``python -I``), listens
on ``127.0.0.1:<port>`` inside, relays each connection to that socket, and
runs the command; it exits with the command's code. It never writes to
stdout or stderr, which belong to the command (an ACP agent speaks JSON-RPC
on stdout).

Usage: ``python -I bridge.py <socket> <port> -- <command> [args...]``
"""

from __future__ import annotations

import signal
import socket
import subprocess
import sys
import threading


def _relay(source: socket.socket, target: socket.socket) -> None:
    try:
        while True:
            chunk = source.recv(65536)
            if not chunk:
                break
            target.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            target.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _serve(listener: socket.socket, socket_path: str) -> None:
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            return
        try:
            upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            upstream.connect(socket_path)
        except OSError:
            client.close()
            continue

        def run(c: socket.socket = client, u: socket.socket = upstream) -> None:
            forward = threading.Thread(target=_relay, args=(c, u), daemon=True)
            forward.start()
            _relay(u, c)
            forward.join()
            c.close()
            u.close()

        threading.Thread(target=run, daemon=True).start()


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[2] != "--":
        return 126
    socket_path, port_text, command = argv[0], argv[1], argv[3:]
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind(("127.0.0.1", int(port_text)))
    except (OSError, ValueError):
        return 126
    listener.listen(64)
    threading.Thread(target=_serve, args=(listener, socket_path), daemon=True).start()
    try:
        child = subprocess.Popen(command)
    except OSError:
        return 127
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, lambda s, _f: child.send_signal(s))
    code = child.wait()
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
