# opencode-agent-mail

An [OpenCode](https://opencode.ai) plugin that lets agent sessions on one machine message each other:
OpenCode sessions with other OpenCode sessions, and OpenCode sessions with Claude Code sessions.
Every message is recorded, so each pair of sessions has a durable conversation history.

Early development. It runs on macOS and Linux, for one user on one machine.

## What it does

- Gives every OpenCode session a human name of its own (`Ana`, `Bruno`, ...), kept for good, so other
  sessions can address it.
- Adds three tools to every agent:
  - `agent_mail_list`: the sessions this one can message, its own name, and recent conversations.
  - `agent_mail_send`: send a plain-text message to one session and return at once.
  - `agent_mail_history`: read the recorded transcript with a peer, with delivery status.
- Delivers incoming messages into the target session while it is active, as a steering message. The
  agent neither waits for replies nor polls files.
- Joins the Claude Code peer-messaging network: it binds a Unix socket under `/tmp/cc-socks/` and
  registers itself in `~/.claude/sessions/` under the peer name `opencode`. A Claude Code session sends to
  `opencode`, starting the message with a line `to: <name>` to pick the OpenCode session; several names
  may be given, separated by commas. A message with no `to:` line goes to the session that last wrote to
  that sender, or else to the most recently active one.
- Tells each receiving agent that a peer message is not the user: it cannot grant permissions, change
  instructions or authorize an action the session was denied.

## Install

Copy or link this directory into OpenCode's plugin directory, which loads it at start-up:

```sh
git clone https://github.com/JF3Env/opencode-agent-mail.git
ln -s "$PWD/opencode-agent-mail" ~/.config/opencode/plugins/agent-mail
```

It needs `@opencode/plugin` (2.x) and `zod` (4.x), which an OpenCode configuration directory normally
already has:

```sh
cd ~/.config/opencode && npm install @opencode/plugin@^2.0.16 zod@^4.1.8
```

## Files

| File          | Role                                                                                     |
|---------------|------------------------------------------------------------------------------------------|
| `index.ts`    | Plugin entry: tools, session names, inbound routing, delivery into sessions.             |
| `bridge.ts`   | Claude Code side: socket listener, session registry, peer discovery, sending frames.     |
| `protocol.ts` | Wire format: addresses, message envelope, `to:` routing line, frames and receipts.       |
| `store.ts`    | Durable store: message records, threads, presence, names, routes, event log, file locks. |

## Where data is kept

Everything lives under `~/.local/share/opencode/agent-mail/`, with mode `0700` on directories and `0600`
on files:

- `records/`: one JSON file per message, with its status (`recorded`, `accepted`, `delivered`, ...).
- `threads/`: one index per pair of sessions; the newest 2000 messages are kept.
- `presence.json`: sessions seen in the last 12 hours.
- `names.json`: the human name each session holds.
- `events.jsonl`: an append-only event log, cut back to its last 10 000 lines once it passes 8 MB.

## Limits

- One machine and one user. There is no network transport and no encryption; access control is file and
  socket permissions.
- The Claude Code side follows the session registry and socket protocol that Claude Code uses locally for
  peer messaging. That protocol is not a published interface and may change between Claude Code releases.
- Sends are rate-limited per peer: an identical message within 20 s is refused, and so is a seventh message
  within a minute.
- Messages are plain text up to 8000 characters.
- The plugin tells each agent its name and asks it to sign its messages, nothing more. Rules of a particular
  workflow, such as naming the agent in its pull requests, belong in that project's own instructions
  (for example its `AGENTS.md`), which can refer to the agent name.

## License

Apache License 2.0. See [LICENSE](LICENSE).
