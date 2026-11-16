# telegram-afk

Talk to the Claude Code sessions on your Mac from Telegram, while you're away from the keyboard.

One bot, one forum topic per session. Each session posts its updates in its own topic, and anything you type in a topic goes to that session only. Permission prompts arrive with Allow and Deny buttons, so a session that needs a yes doesn't sit waiting until you're back at your desk.

I built it because I usually have several sessions running, and walking away meant either leaving them stuck or coming back to a wall of "waiting for input". It pairs well with [Deckhand](https://github.com/Hari-K-Dev/deckhand), which opens sessions with Telegram switched on one by one, and [jarvis-voice](https://github.com/Hari-K-Dev/jarvis-voice), which turns updates into voice notes.

## How it fits together

```
phone (Telegram)  <->  tgd daemon (owns the bot, one poller)  <->  Unix socket
                                                                    |-- channel.ts (session "api-server")
                                                                    |-- channel.ts (session "landing-page")
                                                                    `-- hook.ts (Stop / idle updates in AFK mode)
```

- `daemon.ts`: the only process that talks to Telegram. Telegram allows one poller per bot token, which is why a single-session plugin can't serve several sessions. It creates a topic per session name, reuses it on restart, queues sends at about one per second and checks every message against your Telegram user ID.
- `channel.ts`: a Claude Code channel (MCP server), started once per session. It pushes your Telegram messages into the session, gives Claude a `reply` tool (text and files) and relays permission prompts.
- `hook.ts`: Stop and Notification hook. In AFK mode, it posts the end-of-turn summary to the session's topic, unless Claude already replied that turn.
- `ctl.ts`: `token`, `pair <CODE>`, `status`, `afk on|off`, `voicetest`.

A session's topic is named after its folder. Set `CLAUDE_TG_NAME` in the session's environment (or in the `env` of its MCP config) to name it something else. Deckhand does this for you, using the session's title.

## Setup

You'll need [Bun](https://bun.sh) and Claude Code on macOS.

1. In Telegram, ask BotFather for `/newbot`, then turn on Threaded Mode in the bot's settings.
2. Clone and install:
   ```sh
   git clone https://github.com/Hari-K-Dev/telegram-afk
   cd telegram-afk
   bun install
   ```
3. Save the bot token. It's prompted for and never echoed, and it's stored owner-only in `~/.config/claude-tg/.env`:
   ```sh
   bun ctl.ts token
   ```
4. Install the background daemon. This fills the placeholders in the template with your paths:
   ```sh
   sed -e "s|__BUN__|$(which bun)|" -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" \
     telegram-afk.plist.example > ~/Library/LaunchAgents/io.github.hari-k-dev.telegram-afk.plist
   launchctl load ~/Library/LaunchAgents/io.github.hari-k-dev.telegram-afk.plist
   ```
5. DM your bot. It replies with a code that works for 10 minutes. Approve it on the Mac:
   ```sh
   bun ctl.ts pair <CODE>
   ```
6. Create the MCP config that sessions use:
   ```sh
   sed -e "s|__BUN__|$(which bun)|" -e "s|__REPO__|$PWD|g" mcp.json.example > ~/.config/claude-tg/mcp.json
   ```
7. Start a session with the channel:
   ```sh
   claude --mcp-config ~/.config/claude-tg/mcp.json --dangerously-load-development-channels server:telegram-afk
   ```
   Confirm the development-channel warning once per launch. A shell alias helps.
8. Optional: add `hook.ts` as a Stop hook and as a Notification hook (matcher `idle_prompt`) in `~/.claude/settings.json` for automatic updates in AFK mode.

If topics in the private chat don't work on your phone, create a private group with Topics on, add the bot as an admin with Manage Topics, and put the group's chat ID in `~/.config/claude-tg/state.json` as `"group_id"`.

## Phone commands

- `/sessions` lists live sessions
- `/afk` sends a voice note and update every time a session finishes a turn, and turns the Mac's speakers off
- `/back` stops automatic updates and turns the speakers back on
- `/voicetest` sends a sample voice note to this topic
- `yes abcde` / `no abcde`, or the buttons, answer a permission prompt

## Voice

With [jarvis-voice](https://github.com/Hari-K-Dev/jarvis-voice) installed (`uv sync --extra listen`, plus `ffmpeg`), AFK mode talks:

- A finished turn sends a voice note to the session's topic, with the words as its caption. The full text follows, unless the note already said all of it.
- A deliberate `reply` gets a voice note too, but no second copy of the text.
- A voice message in a topic is transcribed on the Mac, echoed back as `Heard: ...`, and reaches that session as text. It can never answer a permission prompt: use the buttons, where nothing can be misheard.

If any of this fails, the text update still goes out. Set `JARVIS_BIN` if the command isn't at `~/.local/bin/jarvis`.

## Security

Read this before you install it. A bot that can type into your Claude sessions is a powerful thing to leave lying around.

**Who can control your sessions.** Only the Telegram account you paired. Every message and button press is checked against that user ID (and chat), so other people, including members of a group the bot sits in, are ignored. Pairing only works in a private chat, needs a code confirmed on the Mac within 10 minutes, and closes for good once you've paired. If `state.json` is damaged, the daemon stops rather than quietly reopening pairing.

**Your Telegram account is the key.** Whoever controls it, on any logged-in device including Telegram Desktop and Web, can instruct sessions and approve tool use. Keep two-step verification on.

**Forwarded messages are not instructions.** If you forward someone else's message into a topic, the session gets it labelled as written by someone else, with a note to treat it as untrusted data. A forwarded "yes abcde" never approves anything. Claude can still be talked into things by clever text, so be careful what you forward to a session with broad permissions.

**Telegram is not end-to-end encrypted for bots.** Permission previews (which can include commands and file contents), end-of-turn summaries, session titles and any files Claude sends all pass through Telegram's servers. Don't use this for work you couldn't put in a normal Telegram chat.

**What stays on your Mac.** The token, state and socket live in `~/.config/claude-tg/`, which is owner-only (`0700`, files `0600`). Downloads from the phone are removed after a day. The log records timings, IDs and errors, never message text or the token. Any process running as your user can talk to the daemon's socket. That's the same trust level as your shell, so it's fine on a personal Mac.

**The development-channel flag.** Custom channels need `--dangerously-load-development-channels` during Claude Code's channels research preview. The flag lets Claude Code load a channel server that isn't on its allowlist, in this case `channel.ts` from this repo. Only point it at code you've read.

## Tests

`bun test` runs the real daemon and two channel sessions against a fake Bot API. The tests cover pairing, routing, strangers, forwarded messages, permissions, AFK updates and voice notes.

## Caveats

- Channels only work in interactive sessions, not `claude -p`.
- macOS only for now: the daemon runs under launchd and the voice features expect jarvis-voice.

---

MIT licensed, see [LICENSE](LICENSE).

<sub>A personal project with no connection to Anthropic or Telegram. Claude and Claude Code are Anthropic's trademarks.</sub>
