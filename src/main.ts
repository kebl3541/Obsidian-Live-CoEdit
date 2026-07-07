import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
} from "obsidian";
import { diffLines, merge3 } from "./merge";

// Live Co-Edit keeps a shadow copy of every open markdown file. When the file
// changes on disk while it is open (an AI assistant, script, or other editor
// wrote to it), the external change is either three-way merged into the
// editor automatically, or — in approval mode — held as a pending proposal
// the user reviews and approves like a pull request.

const MAX_FILE_SIZE = 2_000_000; // bytes; larger files are left to Obsidian

interface LiveCoEditSettings {
  // "auto": external edits merge straight into the editor.
  // "approve": external edits wait for explicit approval.
  applyMode: "auto" | "approve";
}

const DEFAULT_SETTINGS: LiveCoEditSettings = {
  applyMode: "auto",
};

interface PendingEdit {
  // Content the collaborator wrote to disk.
  theirs: string;
  // Content both sides last agreed on.
  base: string;
}

export default class LiveCoEditPlugin extends Plugin {
  settings: LiveCoEditSettings = DEFAULT_SETTINGS;

  // Last content both the editor and the disk agreed on, per file path.
  private shadows = new Map<string, string>();
  // External edits awaiting user approval, per file path.
  private pending = new Map<string, PendingEdit>();
  private pendingNotices = new Map<string, Notice>();
  private statusEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.statusEl = this.addStatusBarItem();
    this.setStatus("ready");

    this.registerEvent(
      this.app.vault.on("modify", (f) => void this.onDiskChange(f))
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (f) => {
        if (f) void this.captureShadow(f);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        const shadow = this.shadows.get(oldPath);
        if (shadow !== undefined) {
          this.shadows.delete(oldPath);
          this.shadows.set(f.path, shadow);
        }
        const pend = this.pending.get(oldPath);
        if (pend !== undefined) {
          this.pending.delete(oldPath);
          this.pending.set(f.path, pend);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        this.shadows.delete(f.path);
        this.dropPending(f.path);
      })
    );

    this.addCommand({
      id: "review-pending-edit",
      name: "Review pending external edit",
      callback: () => this.reviewCommand(),
    });

    this.addCommand({
      id: "resync-active-file",
      name: "Re-sync active file from disk",
      callback: () => void this.resyncActive(),
    });

    this.addSettingTab(new LiveCoEditSettingTab(this));

    this.app.workspace.onLayoutReady(() => {
      const f = this.app.workspace.getActiveFile();
      if (f) void this.captureShadow(f);
    });
  }

  onunload() {
    this.shadows.clear();
    for (const n of this.pendingNotices.values()) n.hide();
    this.pendingNotices.clear();
    this.pending.clear();
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<LiveCoEditSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private setStatus(text: string) {
    this.statusEl?.setText(`Co-edit: ${text}`);
  }

  private async captureShadow(file: TFile) {
    if (file.extension !== "md" || file.stat.size > MAX_FILE_SIZE) return;
    if (!this.shadows.has(file.path)) {
      this.shadows.set(file.path, await this.app.vault.cachedRead(file));
    }
  }

  private findEditorFor(path: string): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) {
        return view.editor;
      }
    }
    return null;
  }

  // The heart of the plugin: the file changed on disk. Decide whether that
  // was Obsidian's own save (no-op), an external edit to auto-merge, or an
  // external edit to queue for approval.
  private async onDiskChange(af: TAbstractFile) {
    if (!(af instanceof TFile) || af.extension !== "md") return;
    if (af.stat.size > MAX_FILE_SIZE) return;

    const disk = await this.app.vault.cachedRead(af);
    const editor = this.findEditorFor(af.path);

    if (!editor) {
      // Not open anywhere: just remember the new agreed content.
      this.shadows.set(af.path, disk);
      return;
    }

    const buffer = editor.getValue();
    if (buffer === disk) {
      // Obsidian's own autosave (or identical content) — nothing to merge.
      this.shadows.set(af.path, disk);
      return;
    }

    const base = this.shadows.get(af.path) ?? buffer;

    if (this.settings.applyMode === "approve") {
      // Hold the proposal; the user decides. The editor stays untouched.
      this.pending.set(af.path, { theirs: disk, base });
      this.announcePending(af.path);
      return;
    }

    this.applyExternal(af.path, editor, buffer, base, disk);
  }

  private applyExternal(
    path: string,
    editor: Editor,
    buffer: string,
    base: string,
    theirs: string
  ) {
    let merged: string;
    let conflicts = 0;
    if (buffer === base) {
      merged = theirs;
    } else {
      const result = merge3(base, buffer, theirs);
      merged = result.merged;
      conflicts = result.conflicts;
    }

    this.applyMinimalEdit(editor, merged);
    this.shadows.set(path, merged);

    const time = new Date().toLocaleTimeString();
    if (conflicts > 0) {
      this.setStatus(`merged with ${conflicts} conflict(s) at ${time} — kept your text`);
      new Notice(
        `Live Co-Edit: ${conflicts} overlapping edit(s) — your version was kept.`
      );
    } else {
      this.setStatus(`merged external edit at ${time}`);
    }
  }

  // ---- Approval flow --------------------------------------------------------

  private announcePending(path: string) {
    this.setStatus(
      `${this.pending.size} pending edit${this.pending.size === 1 ? "" : "s"} — review to apply`
    );

    // One sticky, clickable notice per file.
    this.pendingNotices.get(path)?.hide();
    const frag = createFragment();
    const div = frag.createDiv();
    div.setText(`External edit proposed for "${path}" — `);
    const link = div.createEl("a", { text: "review" });
    link.addEventListener("click", () => {
      new ReviewModal(this.app, this, path).open();
    });
    const notice = new Notice(frag, 0);
    this.pendingNotices.set(path, notice);
  }

  private dropPending(path: string) {
    this.pending.delete(path);
    this.pendingNotices.get(path)?.hide();
    this.pendingNotices.delete(path);
    if (this.pending.size === 0) this.setStatus("ready");
  }

  getPending(path: string): PendingEdit | undefined {
    return this.pending.get(path);
  }

  // Compute what the file would look like if the pending edit were approved.
  mergedPreview(path: string): string | null {
    const pend = this.pending.get(path);
    if (!pend) return null;
    const editor = this.findEditorFor(path);
    const buffer = editor ? editor.getValue() : null;
    if (buffer === null || buffer === pend.base) return pend.theirs;
    return merge3(pend.base, buffer, pend.theirs).merged;
  }

  async approvePending(path: string) {
    const merged = this.mergedPreview(path);
    if (merged === null) return;
    const editor = this.findEditorFor(path);
    if (editor) {
      this.applyMinimalEdit(editor, merged);
    } else {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.app.vault.modify(f, merged);
    }
    this.shadows.set(path, merged);
    this.dropPending(path);
    this.setStatus(`approved external edit at ${new Date().toLocaleTimeString()}`);
  }

  async rejectPending(path: string) {
    const editor = this.findEditorFor(path);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (editor && f instanceof TFile) {
      // Stamp the user's version back onto disk so the collaborator sees the
      // rejection.
      const buffer = editor.getValue();
      await this.app.vault.modify(f, buffer);
      this.shadows.set(path, buffer);
    }
    this.dropPending(path);
    this.setStatus(`rejected external edit at ${new Date().toLocaleTimeString()}`);
  }

  private reviewCommand() {
    const active = this.app.workspace.getActiveFile();
    const path =
      active && this.pending.has(active.path)
        ? active.path
        : this.pending.keys().next().value;
    if (!path) {
      new Notice("No pending external edits.");
      return;
    }
    new ReviewModal(this.app, this, path).open();
  }

  // ---- Editor mechanics -----------------------------------------------------

  // Replace only the changed region so the cursor and scroll position keep
  // their place through CodeMirror's position mapping.
  private applyMinimalEdit(editor: Editor, next: string) {
    const cur = editor.getValue();
    if (cur === next) return;

    let prefix = 0;
    const minLen = Math.min(cur.length, next.length);
    while (prefix < minLen && cur.charCodeAt(prefix) === next.charCodeAt(prefix)) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < minLen - prefix &&
      cur.charCodeAt(cur.length - 1 - suffix) ===
        next.charCodeAt(next.length - 1 - suffix)
    ) {
      suffix++;
    }

    editor.replaceRange(
      next.slice(prefix, next.length - suffix),
      editor.offsetToPos(prefix),
      editor.offsetToPos(cur.length - suffix)
    );
  }

  currentBuffer(path: string): string | null {
    return this.findEditorFor(path)?.getValue() ?? null;
  }

  // Manual escape hatch: throw away local state and reload from disk.
  private async resyncActive() {
    const file = this.app.workspace.getActiveFile();
    const editor = file ? this.findEditorFor(file.path) : null;
    if (!file || !editor) {
      new Notice("Open a markdown file first.");
      return;
    }
    const disk = await this.app.vault.cachedRead(file);
    this.applyMinimalEdit(editor, disk);
    this.shadows.set(file.path, disk);
    this.dropPending(file.path);
    this.setStatus("re-synced from disk");
  }
}

// ---- Review dialog ----------------------------------------------------------

class ReviewModal extends Modal {
  private plugin: LiveCoEditPlugin;
  private path: string;

  constructor(app: App, plugin: LiveCoEditPlugin, path: string) {
    super(app);
    this.plugin = plugin;
    this.path = path;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Proposed edit — ${this.path}`);

    const merged = this.plugin.mergedPreview(this.path);
    const buffer = this.plugin.currentBuffer(this.path);
    if (merged === null) {
      contentEl.setText("This edit is no longer pending.");
      return;
    }

    const before = buffer ?? this.plugin.getPending(this.path)?.base ?? "";
    this.renderDiff(contentEl, before, merged);

    const buttons = contentEl.createDiv({ cls: "live-coedit-buttons" });
    const approve = buttons.createEl("button", { text: "Approve" });
    approve.addClass("mod-cta");
    approve.addEventListener("click", () => {
      void this.plugin.approvePending(this.path);
      this.close();
    });
    const reject = buttons.createEl("button", { text: "Reject" });
    reject.addClass("mod-warning");
    reject.addEventListener("click", () => {
      void this.plugin.rejectPending(this.path);
      this.close();
    });
    const later = buttons.createEl("button", { text: "Decide later" });
    later.addEventListener("click", () => this.close());
  }

  // Simple line diff: red for lines the proposal removes, green for lines it
  // adds, with two lines of context around each change.
  private renderDiff(containerEl: HTMLElement, before: string, after: string) {
    const beforeLines = before.split("\n");
    const hunks = diffLines(beforeLines, after.split("\n"));

    const box = containerEl.createDiv({ cls: "live-coedit-diff" });
    if (hunks.length === 0) {
      box.setText("(no visible changes)");
      return;
    }

    const CONTEXT = 2;
    for (const h of hunks) {
      const ctxStart = Math.max(0, h.baseStart - CONTEXT);
      for (let i = ctxStart; i < h.baseStart; i++) {
        box.createDiv({ cls: "live-coedit-line", text: `  ${beforeLines[i]}` });
      }
      for (let i = h.baseStart; i < h.baseEnd; i++) {
        box.createDiv({
          cls: "live-coedit-line live-coedit-del",
          text: `- ${beforeLines[i]}`,
        });
      }
      for (const line of h.lines) {
        box.createDiv({
          cls: "live-coedit-line live-coedit-add",
          text: `+ ${line}`,
        });
      }
      const ctxEnd = Math.min(beforeLines.length, h.baseEnd + CONTEXT);
      for (let i = h.baseEnd; i < ctxEnd; i++) {
        box.createDiv({ cls: "live-coedit-line", text: `  ${beforeLines[i]}` });
      }
      box.createDiv({ cls: "live-coedit-sep" });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Settings ---------------------------------------------------------------

class LiveCoEditSettingTab extends PluginSettingTab {
  plugin: LiveCoEditPlugin;

  constructor(plugin: LiveCoEditPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("External edits")
      .setDesc(
        "Apply automatically: external changes merge straight into your editor. Require approval: each external change waits as a proposal you review (diff + approve/reject) before it touches your note."
      )
      .addDropdown((dd) =>
        dd
          .addOption("auto", "Apply automatically")
          .addOption("approve", "Require my approval")
          .setValue(this.plugin.settings.applyMode)
          .onChange(async (v) => {
            this.plugin.settings.applyMode = v as "auto" | "approve";
            await this.plugin.saveSettings();
          })
      );
  }
}
