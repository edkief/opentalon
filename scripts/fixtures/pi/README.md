# Recorded pi sessions

Real `pi --mode rpc` sessions (pi 1.1.0, `@earendil-works/pi-coding-agent`), one scenario each.
They are vendored from [edkief/ralph@82dc5a5](https://github.com/edkief/ralph/tree/82dc5a5e1169319e8ea17ffe8e64e2b3f10ada96/test/fixtures/pi),
which also has the scripts that record them (`capture/`).

Each line is `{t, dir, line}`:
- `t` is milliseconds since the process started.
- `dir` is `in` (a command the client sent) or `out` (what pi wrote on stdout).
- `line` is the JSON line itself.

The model was a scripted OpenAI-compatible stub, not a real LLM. The protocol, the ordering and the
event JSON are pi's own, but the token counts are what the stub reported.

| File | Scenario |
|---|---|
| `tool-turn` | A turn that runs a bash tool call, then answers |
| `abort` | A turn stopped mid-tool with `abort` |
| `retry` | A provider error retried automatically, then success |
| `overflow` | A context overflow that compaction cannot recover |
| `overflow-recovered` | A context overflow recovered by compacting and running again |
| `compact` | A manual `compact` |
| `steer` | A steered prompt mid-turn |
| `extension-dialog` | An extension opening a dialog, which the client cancels |
| `models` | Templates for the state and model commands the fake answers itself |
| `gate-allow` | A bash call put to the permission gate and allowed |
| `gate-block` | A bash call put to the gate and blocked, with the reason the agent is told |
| `gate-cancelled` | A bash call put to the gate whose request is cancelled, which blocks it |
| `gate-write` | A `write` call put to the gate: its path is sent, not its content |

`fake-pi.mjs` replays these as a stand-in `pi` binary (see its header for the `FAKE_PI` options).
`scripts/test-pi-translate.ts` translates them, and `scripts/test-pi-session.ts` drives `PiSession`
against the fake.

The gate recordings (`gate-*.jsonl`, #70) were made with Ralph's gate extension; the dialog title,
command, extension file name and the word "Ralph" in its messages are rewritten to OpenTalon's
(`opentalon:gate`, `opentalon-gate`), which is all that differs. `scripts/test-pi-gate.ts` drives
`PiSession` through them. To support a new pi version, record the scenarios again on that version with Ralph's capture scripts, copy them here,
and check the tests still pass.
