# next-steps-desktop

A copy of `next-steps` from [anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community) (Thariq Shihipar, MIT), drawn on the desktop Code tab as well as the terminal. It also skips subagent turns, adds a Send button beside every suggestion, and its dismiss button is the desktop's native close control.

After each turn, suggests up to three next prompts above the input box.

```
next:
  1: run the tests you just wrote
  2: do the same for the settings page
  3: /code-review high
  0: dismiss
```

Press `1`, `2` or `3` from an empty prompt box (or click one) and that prompt is written into the box as a draft. Edit it, then press Enter yourself. `0` dismisses. The top suggestion also shows as the box's dim ghost text, so Tab takes it.

Each suggestion also has a **Send** button that submits it to the session at once, as your own prompt; when the prompt box shows its own dim suggestion, the band offers that one too, with the same button. Nothing is sent unless you press Send.

## How it works

It is a function-hooks plugin (`hooks/register.tsx`):

- `turn.complete`: forks the session with `$.model.fork` to ask for likely next prompts. The fork shares the session's prompt cache, so it costs about one short reply.
- `$.command.list`: the session's skills and slash commands (plugin, user and MCP ones with their descriptions) go into the fork's question, so a suggestion can be `/skill arguments`. A suggestion that names a command the session does not have is dropped.
- `ui.render` on `AbovePrompt`: draws the suggestions as buttons.
- A press calls `$.prompt.fill`; the top suggestion goes to `$.prompt.suggest`.
- `turn.start`: hides the suggestions.

Suggestions draw in the terminal and the desktop Code tab (the two surfaces that raise `AbovePrompt`). VS Code and mobile show nothing.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `minAnswerChars` | `80` | Skip suggestions after answers shorter than this |
| `suggestSkills` | `true` | Tell the suggester which skills and slash commands the session has |
