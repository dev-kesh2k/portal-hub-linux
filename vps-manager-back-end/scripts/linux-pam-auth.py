#!/usr/bin/env python3
"""Authenticate a Linux user by driving su on a PTY. Username is argv[1]; password is one stdin line."""
import os
import pty
import select
import sys
import time

MARKER = "__HUB_AUTH_OK__"


def main() -> int:
    if len(sys.argv) < 2:
        return 2
    user = sys.argv[1].strip()
    password = sys.stdin.readline().rstrip("\r\n")
    if not user or not password:
        return 1

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["LANG"] = "C"
        os.environ["LC_ALL"] = "C"
        os.execvp("su", ["su", "-", user, "-c", f"printf '{MARKER}\\n'"])

    sent = False
    out = b""
    status = None
    deadline = time.time() + 8

    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if fd in ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            if not sent and b"assword" in out.lower():
                os.write(fd, (password + "\n").encode("utf-8", "ignore"))
                sent = True
        try:
            waited, st = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if waited == pid:
            status = st
            try:
                while True:
                    more, _, _ = select.select([fd], [], [], 0.05)
                    if fd not in more:
                        break
                    chunk = os.read(fd, 4096)
                    if not chunk:
                        break
                    out += chunk
            except OSError:
                pass
            break

    if status is None:
        try:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
        except OSError:
            pass
        return 1

    text = out.decode("utf-8", "ignore").replace("\r", "\n")
    ok = MARKER in text and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
    if ok:
        sys.stdout.write("ok\n")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
