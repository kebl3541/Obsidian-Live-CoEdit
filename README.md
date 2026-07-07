# AI Co-Editor

[![Downloads](https://img.shields.io/github/downloads/kebl3541/Obsidian-AI-Co-Editor/total?style=flat&logo=github&label=Downloads&color=success&cacheSeconds=3600)](https://github.com/kebl3541/Obsidian-AI-Co-Editor/releases)
[![GitHub stars](https://img.shields.io/github/stars/kebl3541/Obsidian-AI-Co-Editor?style=flat&logo=github&label=Stars&cacheSeconds=3600)](https://github.com/kebl3541/Obsidian-AI-Co-Editor/stargazers)
[![Latest release](https://img.shields.io/github/v/release/kebl3541/Obsidian-AI-Co-Editor?style=flat&label=Release&cacheSeconds=3600)](https://github.com/kebl3541/Obsidian-AI-Co-Editor/releases/latest)

<p align="center">If this plugin adds value for you and you would like to help support
continued development, please use the buttons below:</p>

<p align="center">
<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>
</p>

<p align="center"><strong><a href="https://buymeacoffee.com/philosophizer">☕ Buy me a coffee</a></strong>&nbsp;&nbsp;·&nbsp;&nbsp;<strong><a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR">💙 Donate via PayPal</a></strong></p>

<p align="center">If you like this plugin or find it useful, please consider giving it a <a href="https://github.com/kebl3541/Obsidian-AI-Co-Editor">star</a> <a href="https://github.com/kebl3541/Obsidian-AI-Co-Editor"><img src="https://img.shields.io/github/stars/kebl3541/Obsidian-AI-Co-Editor?style=social" alt="GitHub Repo stars"></a> on GitHub!</p>


Write **with** an AI inside Obsidian, on your terms. The AI proposes edits to
your open note; you see them as tracked changes, in the note itself, and
accept or refuse them word by word. Nothing enters your text without your
judgment.

## How it works

This plugin is the review layer, not the AI. It watches your vault, and when
a connected AI edits a note it turns that edit into a proposal: struck
deletions and green insertions rendered inside the note, each with accept and
reject buttons, plus a side panel with a chat for giving directions. The AI
itself plugs in separately, and takes about five minutes to connect.

## Quick start

1. Install and enable the plugin.
2. Connect Claude: get an API key at console.anthropic.com, then in a
   terminal run

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   python3 integrations/claude-bridge.py "/path/to/YourVault"
   ```

   The bridge is a single Python file from this repo, no installs needed.
   Leave it running while you write.
3. In Obsidian, open the co-edit panel (the users icon on any note, or the
   status bar item), type an instruction in the chat, and press Send. The
   reply and any proposed edits arrive in seconds.
4. Select any passage in a note and choose "Ask your AI collaborator to edit
   this" to request a change to exactly that text.

Users of agent tools that already edit local files, such as Claude Code, need
no bridge at all: point the tool at your vault and the plugin picks its edits
up automatically.

## What you get

- **Tracked changes in the note**: proposed deletions struck through, proposed
  insertions as green ghosts, an accept and a reject button on every change.
- **A review dialog** for bigger proposals, with per change checkboxes,
  conflict choices, and Enter to apply.
- **A side panel**: chat with your AI, pending proposals with inline previews
  and one click Accept all or Reject, their changes highlighted per author
  color, comments, and an activity feed.
- **Authorship you can see**: every accepted phrase is marked in its author's
  color, and an audit note records who changed what and when.
- **Snapshots**: the state before every external edit is kept, restorable any
  time.
- **Protected sections**: wrap text in `%%protect%% ... %%/protect%%` and no
  collaborator can change it.
- **Modes per folder**: require approval everywhere, merge automatically in
  scratch folders, or switch the plugin off for chosen paths.
- **Several AIs at once**: each collaborator gets a name, a color, and its own
  address in the chat switcher.

## Safety model

Your words cannot be silently lost or replaced. Concurrent edits are three way
merged at word level; conflicts keep your version; proposals wait for your
decision whether the note is open, closed, or Obsidian was not even running
when the edit happened; and every applied change has a snapshot behind it.

Two behaviors worth knowing about, both local to your machine: the plugin
lists your markdown files once at startup to remember a baseline for recent
notes, which is how edits made while Obsidian was closed still become
reviewable proposals; and it never makes network requests. Nothing leaves
your vault.

## Connecting other AIs

**Perplexity** ([`perplexity-bridge.py`](integrations/perplexity-bridge.py)):
same steps with `PERPLEXITY_API_KEY` and the name "perplexity".

Several collaborators can work at the same time: address each one from the
chat switcher, and review everyone's proposals in the same panel. Tools that
edit vault files directly (such as Claude Code) need no bridge at all.

## For integrators

Any tool that edits vault files can collaborate. To be a first class citizen:

1. Write `{"name":"yourtool"}` to `.obsidian/live-coedit-collaborator.json`
   just before each edit, so changes get your color and attribution.
2. Optionally write `{"name":"yourtool","state":"working","ts":<ms>}` to
   `.obsidian/live-coedit-status.json` while working, and set it back to
   `"idle"` when done, to drive the liveness indicator.
3. After writing a file, re-read it a moment later and re-apply if your change
   is missing: Obsidian's autosave can occasionally win a very close race. The
   bundled Perplexity bridge shows the pattern in `write_verified`.

## Install (manual)

1. `npm install && npm run build`
2. Copy `main.js` and `manifest.json` into
   `<YourVault>/.obsidian/plugins/live-coedit/`
3. Enable **AI Co-Editor** under Settings → Community plugins.

## Support

If this plugin adds value for you and you would like to help support continued
development, please use the buttons below:

<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>


## License

MIT
