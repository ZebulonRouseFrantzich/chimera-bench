# llama.cpp Subprocess Startup

Startup is split into "started" vs "ready".

Spawn:

- Start `llama-server` as a detached process group.
- Pipe stdout/stderr and buffer them in bounded rolling buffers.
- `unref()` the subprocess.

Startup probe window:

- Treat "process did not exit within a short probe window" as *started*.
- This is not readiness; readiness is a separate probe.
- Early exit/error within the probe window is a startup failure.

Port retry:

- Allocate a loopback port and pass `--host 127.0.0.1 --port <port>`.
- If startup fails due to bind/early-exit, retry with a new loopback port up to a small attempt cap.
- On final failure, include bounded stdout/stderr excerpts in the error.
