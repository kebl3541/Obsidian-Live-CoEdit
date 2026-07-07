# AI Co-Editor

[![Downloads](https://img.shields.io/github/downloads/kebl3541/Obsidian-AI-Co-Editor/total?style=flat&logo=github&label=Downloads&color=success)](https://github.com/kebl3541/Obsidian-AI-Co-Editor/releases)
[![GitHub stars](https://img.shields.io/github/stars/kebl3541/Obsidian-AI-Co-Editor?style=flat&logo=github&label=Stars)](https://github.com/kebl3541/Obsidian-AI-Co-Editor/stargazers)
[![Latest release](https://img.shields.io/github/v/release/kebl3541/Obsidian-AI-Co-Editor?style=flat&label=Release)](https://github.com/kebl3541/Obsidian-AI-Co-Editor/releases/latest)

<p align="center">If this plugin adds value for you and you would like to help support
continued development, please use the buttons below:</p>

<p align="center">
<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>
</p>

<p align="center">…and if this plugin makes your day a little easier, please give it a ⭐ on <a href="https://github.com/kebl3541/Obsidian-AI-Co-Editor">GitHub</a>, it helps others find it!</p>


Co-edit the **same open note simultaneously with an AI** (Claude Code and other
file-editing assistants). It proposes, you review as track changes, and
nobody's words get lost. Works with scripts and other external editors too.

## The problem it solves

Obsidian autosaves your typing every couple of seconds. If something else
writes to the same file on disk at the same time, one side normally wins and
the other side's edit disappears.

Live Co-Edit keeps a shadow copy of every open markdown file. When the file
changes on disk while you're editing it, the plugin **three-way merges** the
external change into your editor:

- Edits to **different parts** of the note merge silently, and your cursor stays
  exactly where it was.
- Edits to the **same lines** keep **your** version, and a notice tells you a
  conflict was resolved.
- When you're idle, external changes just flow in.

## Using it with an AI assistant

1. Open a note in Obsidian.
2. Ask your assistant (e.g. Claude Code pointed at your vault) to edit the
   same file.
3. Watch its changes appear in your editor while you keep typing.

The status bar shows the last merge (`Co-edit: merged external edit at …`).

## Commands

- **Re-sync active file from disk**: an escape hatch. discard the plugin's local
  state for this file and reload the disk version.

## Working with other AIs (Perplexity example)

The plugin is collaborator agnostic: anything that can edit files in your
vault can propose changes, and each named collaborator gets its own highlight
color. A ready made bridge for Perplexity ships in
[`integrations/perplexity-bridge.py`](integrations/perplexity-bridge.py):

1. Get an API key from Perplexity and put it in your environment
   (`export PERPLEXITY_API_KEY=...`) or a `.env` file beside the script.
2. In Obsidian, add "perplexity" under Settings, AI Co-Editor, Collaborators.
3. Run `python3 integrations/perplexity-bridge.py "/path/to/YourVault"`.
4. Pick "to: perplexity" in the chat switcher and talk to it.

Several collaborators can work at the same time: address each one from the
switcher, and review everyone's proposals in the same panel.

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
