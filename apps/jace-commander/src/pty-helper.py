# JC-owned POSIX PTY relay. Invoked with argv, never interpolated source.
import errno, os, pty, select, signal, sys, time
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
deadline = None
def stop(sig, frame):
    global deadline
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    deadline = time.monotonic() + .25
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            deadline = None
        readable, _, _ = select.select([0, master], [], [], .05)
        if master in readable:
            try: data = os.read(master, 65536)
            except OSError as e:
                if e.errno != errno.EIO: raise
                break
            if not data: break
            os.write(1, data)
        if 0 in readable:
            data = os.read(0, 65536)
            if not data:
                stop(signal.SIGTERM, None)
            else:
                os.write(master, data)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
finally:
    os.close(master)
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
