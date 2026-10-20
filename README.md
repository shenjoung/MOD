# jones-mods — Claude Code desktop mods

Five plugins (function-hook mods) for the Claude Code desktop app, served from one
local marketplace. They customize the composer area, the sidebar and the session
workflow. All UI text is English; model output follows the language you chat in.

| Plugin | What it does |
|---|---|
| **task-sort** | Session classification + the composer toolbar. On each new session a *Classify* band asks who the task is for (dropdown of recent names) and what it does, names the session `YYYY-MM-DD · task`, and files it into a per-person sidebar group. `Sort [Date/Person/Both/Off]` dropdown switches the scheme for new sessions only. Also carries the **Explain** toolkit: `Explain` (plain-words explanation of the last reply — or of selected text — in a side panel, via a context-carrying model fork, no main-conversation turn spent), `Explain in fork` (one click drafts a request that forks the whole conversation into a real side session which explains the last reply, walks through the current next-step suggestions, chats until you decide, then relays the decision back to the parent session), and `/explain` / `/task-sort` commands. |
| **usage-line** | Your 5-hour and 7-day rate-limit usage in the prompt footer (`5h 26% ↻2h0m · 7d 7% ↻11h20m`), from the engine's own readings (same source as `/usage`). Appears after the session's first reply. |
| **next-steps-desktop** | After each turn, up to three likely next prompts above the composer; press one to draft it, or Send to submit it as your own message. Adapted for the desktop Code tab from [next-steps](https://github.com/anthropics/claude-plugins-community) (Thariq Shihipar, MIT). Publishes its current suggestions to shared plugin state so task-sort's fork-explain can walk through them. |
| **paste-offload** | A pasted block over the threshold (default 20k chars) is saved to `~/.claude/pastes/` and the prompt keeps only its head and the file path, so a huge debug dump is not re-read on every later step. |
| **deploy-status** | `/deploys` opens a read-only pane: what prod and integ last deployed for a GitHub repo (default `hourloop/guild`), what is deploying now, and whether your latest commits on main are live on each. Repo and `gh` path configurable. |

## Install

```bash
/plugin marketplace add hourloop/MOD
/plugin install task-sort@jones-mods
/plugin install usage-line@jones-mods
/plugin install next-steps-desktop@jones-mods
/plugin install paste-offload@jones-mods
/plugin install deploy-status@jones-mods
```

Then start a new session (plugins load at session start).

## Notes and hard-won constraints

These took a lot of trial and error against the desktop app (2.1.29x). If you fork
this, they will save you the same loops:

- **Mods cannot inject into the app's native UI.** The Environment/Context card
  stack, the selection popover ("Start a side chat") and the right-pane tabs are
  closed; mods get 15 render components (`AbovePrompt`, `Pane`, `PromptHint`,
  `SessionMode`, …) and nothing else.
- **The desktop app does not draw custom `PromptHint` trees** (tests pass, screen
  shows nothing). The footer's `SessionMode` labels are the only below-composer
  spot, and they take plain text only — that is where usage-line lives.
- **`AbovePrompt` hooks must compose** (`const below = await next(e)`), or they
  silently replace every other plugin's band.
- **Opening a real conversation fork** (`start_session` with
  `initiation: "user_asked"`, `context: "fork"`) requires words the user sent
  themselves. Plugin-origin MCP calls are refused by the auto-mode classifier,
  plugin-origin and even `asUser` prompt submissions get downgraded to an offer
  card, and an accepted offer card can only start a *fresh* session — the app
  forbids `fork` there. The working pattern: the button drafts one short marker
  line into the composer (`$.prompt.fill`), the full instruction rides along as
  hidden context from a `prompt.submit` hook, and the user's own Enter satisfies
  the gate.
- **Cross-plugin writes are forbidden** — only a value's owner writes it. Share
  state by publishing to `$.state` on the owner's side and reading it from the
  other plugin; trigger the owner's behavior through its slash command, not its
  internals.

## Development

Each plugin is plain `hooks/register.tsx` + `.claude-plugin/plugin.json`. Loop:

```bash
claude plugin validate <dir>   # what the engine would refuse
claude plugin test <dir>       # *.test.ts against the real hook engine
```

The marketplace reads plugins in place (directory source), so edits apply to the
next session without reinstalling.

## License

MIT — see [LICENSE](LICENSE). next-steps-desktop retains its upstream MIT
attribution.
