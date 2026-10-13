"""Trusted Linux launcher. fd3: inherited flock, fd4: private control,
fd5: private receipts. No client can inherit the authority/control descriptors.
ECHILD from waitpid(-1) is the settlement proof; process groups are not proof.
"""
import ctypes
import json
import os
import selectors
import signal
import stat
import subprocess
import sys


def capability():
    if sys.platform != "linux":
        raise RuntimeError("Linux required")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
    enabled = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
        raise RuntimeError("PR_GET_CHILD_SUBREAPER")


def receipt(value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    while data:
        data = data[os.write(5, data):]


def launch():
    lock = os.fstat(3)
    if (not stat.S_ISREG(lock.st_mode) or lock.st_size != 0
            or lock.st_uid != os.getuid()
            or stat.S_IMODE(lock.st_mode) != 0o600):
        raise RuntimeError("invalid inherited operator lock")
    capability()  # Each actual launch probes, before accepting any executable.
    receipt({"ready": 1})
    cancelled = False

    def cancel(_signum=None, _frame=None):
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    # Private parent pipe: EOF (including wrapper crash) means cancellation.
    selector = selectors.DefaultSelector()
    selector.register(4, selectors.EVENT_READ)
    data = b""
    while b"\n" not in data:
        if cancelled:
            receipt({"settled": True, "code": 1, "signal": "SIGTERM", "failed": True})
            return
        for _key, _mask in selector.select(0.1):
            chunk = os.read(4, 65536)
            if not chunk:
                receipt({"settled": True, "code": 1, "signal": "SIGTERM", "failed": True})
                return  # no executable has been started
            data += chunk
            if len(data) > 131072:
                raise RuntimeError("request limit")
    line, extra = data.split(b"\n", 1)
    request = json.loads(line)
    if (not isinstance(request, dict)
            or not isinstance(request.get("file"), str)
            or not isinstance(request.get("args"), list)
            or not all(isinstance(x, str) for x in request["args"])):
        raise RuntimeError("request rejected")
    cancelled = cancelled or bool(extra)
    if cancelled:
        receipt({"settled": True, "code": 1, "signal": "SIGTERM", "failed": True})
        return
    try:
        child = subprocess.Popen(
            [request["file"], *request["args"]], cwd=request.get("cwd"),
            env=request.get("env"), close_fds=True)
    except OSError:
        receipt({"settled": True, "code": 1, "signal": None, "failed": True})
        return
    direct_status = None
    signalled = False
    # This process remains a live lock owner even if the Node wrapper dies.
    # Reaping the direct child adopts descendants (including setsid/detached).
    # There is no PID scan and no group kill. An unresponsive descendant retains
    # the lock; the supervisor reports bounded uncertainty separately.
    while True:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                if direct_status is None:
                    raise RuntimeError("direct child status missing")
                code = os.waitstatus_to_exitcode(direct_status)
                receipt({"settled": True, "code": code if code >= 0 else None,
                         "signal": signal.Signals(-code).name if code < 0 else None, "failed": False})
                return
            if pid == 0:
                break
            if pid == child.pid:
                direct_status = status
                child.returncode = os.waitstatus_to_exitcode(status)
        if cancelled and not signalled and direct_status is None:
            # Exact unreaped Popen child only: no reused PID can exist before
            # waitpid reaps it; all reaping/signalling is in this single thread.
            # Popen.send_signal calls poll(), which could reap behind this
            # wait loop. Signal only this known, still-unreaped child instead.
            try:
                os.kill(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass  # waitpid remains the sole settlement authority
            signalled = True
        for _key, _mask in selector.select(0.1):
            chunk = os.read(4, 65536)
            cancelled = True
            if not chunk:
                selector.unregister(4)


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        capability()
        print("coach-native-subreaper-1")
    elif sys.argv[1:]:
        raise RuntimeError("arguments rejected")
    else:
        launch()
