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
import type { EditorView } from "@codemirror/view";
import {
  Segment,
  composeSegments,
  diffLines,
  diffWords,
  merge3,
  merge3Segments,
} from "./merge";
import {
  MarkRange,
  SlottedRange,
  addExternalMarks,
  clearExternalMarks,
  commentHighlighter,
  removeMarkRange,
  externalMarksField,
  readMarks,
} from "./marks";
import {
  clearInlineProposals,
  inlineProposalsField,
  setInlineProposals,
  InlineAdd,
  InlineDel,
} from "./inline";
import { SnapshotStore, SnapshotInfo } from "./snapshots";
import { CoComment, scanComments } from "./comments";
import { CoEditPanelView, PANEL_VIEW_TYPE } from "./panel";

const DEFAULT_MAX_FILE_KB = 2000; // larger files are left to Obsidian

type ApplyMode = "auto" | "approve" | "off";

interface FolderRule {
  prefix: string;
  mode: ApplyMode;
}

interface Collaborator {
  name: string;
  slot: number;
}

interface LiveCoEditSettings {
  applyMode: ApplyMode;
  folderRules: FolderRule[];
  auditLog: boolean;
  auditLogPath: string;
  snapshotLimit: number;
  userName: string;
  collaborators: Collaborator[];
  chatPath: string;
  showRestorePoints: boolean;
  collapsedSections: string[];
  // Where the floating "Ask collaborator" button may appear. In editing mode
  // the right-click menu covers the feature, so "reading" is the default.
  askButtonMode: "off" | "reading" | "always";
  // Largest file (in KB) the merge engine will handle; bigger files fall
  // back to Obsidian's default behavior.
  maxFileKB: number;
  // Start each session with an empty chat; prior messages move to an archive note.
  clearChatOnStartup: boolean;
  // Render pending proposals inside the note as track changes.
  inlineProposals: boolean;
  // Keep collaborator highlights across restarts. Off by default: closing
  // Obsidian starts a clean page.
  rememberHighlights: boolean;
  // Which collaborator chat messages and requests are addressed to.
  // "everyone" broadcasts; a name targets that agent only.
  activeCollaborator: string;
}

const DEFAULT_SETTINGS: LiveCoEditSettings = {
  applyMode: "auto",
  folderRules: [],
  auditLog: true,
  auditLogPath: "Co-edit log.md",
  snapshotLimit: 10,
  userName: "me",
  collaborators: [],
  chatPath: "Co-edit chat.md",
  showRestorePoints: false,
  collapsedSections: ["Activity"],
  askButtonMode: "reading",
  activeCollaborator: "everyone",
  maxFileKB: DEFAULT_MAX_FILE_KB,
  rememberHighlights: false,
  inlineProposals: true,
  clearChatOnStartup: true,
};

export interface ChatMessage {
  name: string;
  time: string;
  text: string;
  target?: string;
}

interface PendingEdit {
  theirs: string;
  base: string;
  collaborator: string;
}

interface PersistedHighlights {
  hash: string;
  marks: SlottedRange[];
}

interface PersistedData {
  settings: LiveCoEditSettings;
  highlights: Record<string, PersistedHighlights>;
  pending?: Record<string, PendingEdit>;
  // Last-seen content of recently co-edited files, so external edits made
  // while Obsidian was closed still become reviewable proposals on launch.
  shadows?: Record<string, string>;
}

export interface MarkListing {
  from: number;
  to: number;
  line: number;
  excerpt: string;
  slot: number;
  name: string;
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export default class LiveCoEditPlugin extends Plugin {
  settings: LiveCoEditSettings = DEFAULT_SETTINGS;

  private shadows = new Map<string, string>();
  private pending = new Map<string, PendingEdit>();
  private pendingNotices = new Map<string, Notice>();
  private highlights: Record<string, PersistedHighlights> = {};
  private selfWrites = new Set<string>();
  private activity: string[] = [];
  private statusEl: HTMLElement | null = null;
  private snapshots!: SnapshotStore;
  private identityCache: { name: string; at: number } = { name: "", at: 0 };

  // Collaborator liveness: external tools write
  // {"name":"claude","state":"working"|"idle","ts":<ms>} to
  // <configDir>/live-coedit-status.json while they work.
  collabStatus: { name: string; state: string; ts: number } | null = null;
  private changeQueue: Promise<void> = Promise.resolve();
  private lastStatusVisible = false;

  // Cache of computed review segments, keyed by content hashes, so panel
  // refreshes while typing do not recompute an LCS diff every second.
  private reviewCache = new Map<
    string,
    { key: string; data: { segments: Segment[]; buffer: string; collaborator: string } }
  >();

  async onload() {
    await this.loadPersisted();

    this.snapshots = new SnapshotStore(
      this.app.vault.adapter,
      `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      this.settings.snapshotLimit
    );

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("live-coedit-statusbar");
    this.statusEl.setAttribute("aria-label", "Open co-edit panel");
    this.statusEl.addEventListener("click", () => void this.openPanel());
    this.setStatus("ready");

    this.registerEditorExtension([
      externalMarksField,
      commentHighlighter,
      inlineProposalsField,
    ]);
    this.registerView(PANEL_VIEW_TYPE, (leaf) => new CoEditPanelView(leaf, this));
    this.addRibbonIcon("users", "Open co-edit panel", () => void this.openPanel());

    // Serialize disk-change handling: overlapping async merges on rapid
    // events could otherwise interleave and merge from stale state.
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        this.changeQueue = this.changeQueue
          .then(() => this.onDiskChange(f))
          .catch((e) => console.error("AI Co-Editor: merge failed", e));
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (f) => {
        if (f) {
          void this.captureShadow(f);
          // Give the editor a beat to finish loading the file's content, or
          // the hash check would wrongly discard stored highlights.
          window.setTimeout(() => {
            this.restoreHighlights(f);
            const pend = this.pending.get(f.path);
            const ed = this.findEditorFor(f.path);
            if (
              pend &&
              ed &&
              ed.getValue() === pend.theirs &&
              pend.base !== pend.theirs
            ) {
              // The proposal text reached disk while the file was closed;
              // show the user THEIR version and render the proposal as
              // reviewable ghosts instead.
              this.applyMinimalEdit(ed, pend.base);
              this.shadows.set(f.path, pend.base);
              this.announcePending(f.path, pend.collaborator);
            }
            this.refreshInlineProposals(f.path);
          }, 150);
        }
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
        if (this.highlights[oldPath]) {
          this.highlights[f.path] = this.highlights[oldPath];
          delete this.highlights[oldPath];
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        this.shadows.delete(f.path);
        delete this.highlights[f.path];
        this.dropPending(f.path);
      })
    );

    this.addCommand({
      id: "review-pending-edit",
      name: "Review pending external edit",
      callback: () => this.reviewCommand(),
    });
    this.addCommand({
      id: "accept-all-active",
      name: "Accept all pending changes in active file",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const has = !!f && this.pending.has(f.path);
        if (!checking && f && has) void this.acceptAllPending(f.path);
        return has;
      },
    });
    this.addCommand({
      id: "reject-active",
      name: "Reject pending changes in active file",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const has = !!f && this.pending.has(f.path);
        if (!checking && f && has) void this.rejectPending(f.path);
        return has;
      },
    });
    this.addCommand({
      id: "ask-edit-selection",
      name: "Ask your AI collaborator to edit selection",
      editorCallback: (editor, view) => {
        if (view instanceof MarkdownView) this.askAboutSelection(editor, view);
      },
    });

    // Right-click a selection → send it to the collaborator with instructions.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView) || !editor.somethingSelected())
          return;
        menu.addItem((item) =>
          item
            .setTitle("Ask your AI collaborator to edit this")
            .setIcon("users")
            .onClick(() => this.askAboutSelection(editor, view))
        );
      })
    );

    // Floating "Ask collaborator" button beside any text selection in a note —
    // works in reading view too, where there is no editor context menu.
    this.setupAskButton(activeDocument);
    this.registerEvent(
      this.app.workspace.on("window-open", (win) => this.setupAskButton(win.doc))
    );
    this.addCommand({
      id: "file-history",
      name: "File history (external edits)",
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (f) new HistoryModal(this.app, this, f.path).open();
        else new Notice("Open a markdown file first.");
      },
    });
    this.addCommand({
      id: "open-panel",
      name: "Open co-edit panel",
      callback: () => void this.openPanel(),
    });
    this.addCommand({
      id: "focus-chat",
      name: "Focus co-edit chat",
      callback: () => {
        void this.openPanel().then(() => {
          window.setTimeout(() => {
            for (const leaf of this.app.workspace.getLeavesOfType(
              PANEL_VIEW_TYPE
            )) {
              const box =
                leaf.view.containerEl.querySelector<HTMLTextAreaElement>(
                  ".live-coedit-composer textarea"
                );
              if (box) {
                box.focus();
                return;
              }
            }
          }, 120);
        });
      },
    });
    this.addCommand({
      id: "resync-active-file",
      name: "Re-sync active file from disk",
      callback: () => void this.resyncActive(),
    });
    this.addCommand({
      id: "clear-collaborator-highlights",
      name: "Clear collaborator highlights in active file",
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (f) this.clearHighlightsFor(f.path);
        else new Notice("Open a markdown file first.");
      },
    });
    this.addCommand({
      id: "revert-last-external-edit",
      name: "Restore snapshot (before last external edit)",
      callback: () => void this.restoreLatestSnapshot(),
    });

    this.addSettingTab(new LiveCoEditSettingTab(this));

    // Periodically persist highlight positions so they survive restarts.
    this.registerInterval(
      window.setInterval(() => void this.persistAllMarks(), 60_000)
    );

    // Watch the collaborator's liveness signal (working / idle).
    this.registerInterval(
      window.setInterval(() => void this.pollCollabStatus(), 2_000)
    );

    // Keep the panel current while the note (comments, marks) changes —
    // debounced, and never while the user is typing in the chat box.
    let refreshTimer: number | null = null;
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          this.refreshPanel();
          const f = this.app.workspace.getActiveFile();
          if (f) this.refreshInlineProposals(f.path);
        }, 900);
      })
    );

    // A co-edit button in every note's own toolbar (top-right of the pane).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.addViewActions())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.addViewActions())
    );

    // Capture shadows for EVERY open markdown view (not just the active one):
    // a stale or missing shadow is how unsaved text gets lost in a merge.
    const captureAllOpen = () => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file) {
          void this.captureShadow(view.file);
        }
      }
    };
    this.registerEvent(this.app.workspace.on("layout-change", captureAllOpen));

    this.app.workspace.onLayoutReady(() => {
      void this.archiveChatIfNeeded();
      this.addViewActions();
      captureAllOpen();
      for (const [path, pend] of this.pending) {
        this.announcePending(path, pend.collaborator);
      }
      // Detect edits made while Obsidian was closed: persisted shadow differs
      // from what is on disk now, and nothing is pending yet.
      void (async () => {
        for (const [path, prev] of [...this.shadows.entries()]) {
          if (this.pending.has(path)) continue;
          if (this.modeFor(path) !== "approve") continue;
          const f = this.app.vault.getAbstractFileByPath(path);
          if (!(f instanceof TFile)) continue;
          const disk = await this.app.vault.cachedRead(f);
          if (disk !== prev) {
            const who = await this.collaboratorName();
            const guarded = this.applyProtectedRegions(prev, disk);
            this.pending.set(path, { theirs: guarded, base: prev, collaborator: who });
            this.announcePending(path, who);
            this.log(`${who} edited ${path} while Obsidian was closed`);
          }
        }
        // Bootstrap baselines for recent notes so that external edits to
        // never-opened files still get proposals instead of slipping in.
        const recentFiles = this.app.vault
          .getMarkdownFiles()
          .filter(
            (f) =>
              f.stat.size <= 200_000 &&
              f.path !== this.settings.chatPath &&
              f.path !== this.settings.auditLogPath &&
              f.path !== this.chatArchivePath()
          )
          .sort((a, b) => b.stat.mtime - a.stat.mtime)
          .slice(0, 100);
        for (const f of recentFiles) {
          if (!this.shadows.has(f.path)) {
            this.shadows.set(f.path, await this.app.vault.cachedRead(f));
          }
        }
        void this.saveSettings();
        const active = this.app.workspace.getActiveFile();
        if (active) this.refreshInlineProposals(active.path);
      })();
      const f = this.app.workspace.getActiveFile();
      if (f) this.restoreHighlights(f);
    });
  }

  onunload() {
    void this.persistAllMarks();
    for (const n of this.pendingNotices.values()) n.hide();
    this.pendingNotices.clear();
    this.pending.clear();
    this.shadows.clear();
  }

  // ---- Persistence ----------------------------------------------------------

  private async loadPersisted() {
    const raw = (await this.loadData()) as Partial<PersistedData> | null;
    if (raw && typeof raw === "object" && "settings" in raw) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings);
      this.highlights = this.settings.rememberHighlights
        ? raw.highlights ?? {}
        : {};
      for (const [path, pend] of Object.entries(raw.pending ?? {})) {
        this.pending.set(path, pend);
      }
      for (const [path, content] of Object.entries(raw.shadows ?? {})) {
        this.shadows.set(path, content);
      }
    } else {
      // v1 data.json stored the settings object directly.
      this.settings = Object.assign(
        {},
        DEFAULT_SETTINGS,
        raw as Partial<LiveCoEditSettings> | null
      );
      this.highlights = {};
    }
  }

  async saveSettings() {
    this.snapshots?.setLimit(this.settings.snapshotLimit);
    // Persist the most recent shadows (small files only) so closed-vault
    // external edits are caught on next launch.
    const shadowEntries = [...this.shadows.entries()]
      .filter(([, content]) => content.length <= 200_000)
      .slice(-20);
    const data: PersistedData = {
      settings: this.settings,
      highlights: this.settings.rememberHighlights ? this.highlights : {},
      pending: Object.fromEntries(this.pending),
      shadows: Object.fromEntries(shadowEntries),
    };
    await this.saveData(data);
  }

  private async persistAllMarks() {
    let changed = false;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const cm = this.editorView(view.editor);
      if (!cm) continue;
      const marks = readMarks(cm);
      const path = view.file.path;
      if (marks.length > 0) {
        this.highlights[path] = {
          hash: hashStr(view.editor.getValue()),
          marks,
        };
        changed = true;
      } else if (this.highlights[path]) {
        delete this.highlights[path];
        changed = true;
      }
    }
    if (changed) await this.saveSettings();
  }

  private restoreHighlights(file: TFile) {
    const stored = this.highlights[file.path];
    if (!stored) return;
    const editor = this.findEditorFor(file.path);
    const cm = editor ? this.editorView(editor) : null;
    if (!editor || !cm) return;
    if (hashStr(editor.getValue()) !== stored.hash) {
      delete this.highlights[file.path];
      return;
    }
    if (readMarks(cm).length > 0) return; // already live
    const bySlot = new Map<number, MarkRange[]>();
    for (const m of stored.marks) {
      const list = bySlot.get(m.slot) ?? [];
      list.push({ from: m.from, to: m.to });
      bySlot.set(m.slot, list);
    }
    for (const [slot, ranges] of bySlot) {
      cm.dispatch({ effects: addExternalMarks.of({ ranges, slot }) });
    }
  }

  // ---- Identity & modes -------------------------------------------------------

  // External collaborators identify themselves by writing
  // {"name": "claude"} to <configDir>/live-coedit-collaborator.json
  // before editing. Unknown writers show up as "collaborator".
  private async collaboratorName(): Promise<string> {
    const now = Date.now();
    if (now - this.identityCache.at < 5_000) return this.identityCache.name;
    let name = "collaborator";
    try {
      const p = `${this.app.vault.configDir}/live-coedit-collaborator.json`;
      if (await this.app.vault.adapter.exists(p)) {
        const parsed = JSON.parse(await this.app.vault.adapter.read(p)) as {
          name?: string;
        };
        if (parsed.name) name = parsed.name;
      }
    } catch {
      // ignore malformed signal files
    }
    this.identityCache = { name, at: now };
    return name;
  }

  slotFor(name: string): number {
    const existing = this.settings.collaborators.find((c) => c.name === name);
    if (existing) return existing.slot;
    const slot = (this.settings.collaborators.length % 6) + 1;
    this.settings.collaborators.push({ name, slot });
    void this.saveSettings();
    return slot;
  }

  private nameForSlot(slot: number): string {
    return (
      this.settings.collaborators.find((c) => c.slot === slot)?.name ??
      "collaborator"
    );
  }

  private modeFor(path: string): ApplyMode {
    let best: FolderRule | null = null;
    for (const rule of this.settings.folderRules) {
      if (!rule.prefix) continue;
      if (path === rule.prefix || path.startsWith(rule.prefix + "/") || path.startsWith(rule.prefix)) {
        if (!best || rule.prefix.length > best.prefix.length) best = rule;
      }
    }
    return best ? best.mode : this.settings.applyMode;
  }

  // ---- Core flow ---------------------------------------------------------------

  private setStatus(text: string) {
    this.statusEl?.setText(`Co-edit ${this.manifest.version}: ${text}`);
  }

  private log(entry: string) {
    const time = new Date().toLocaleTimeString();
    this.activity.unshift(`${time} — ${entry}`);
    if (this.activity.length > 20) this.activity.pop();
    this.refreshPanel();
  }

  recentActivity(): string[] {
    return this.activity;
  }

  private async captureShadow(file: TFile) {
    if (file.extension !== "md" || file.stat.size > this.maxFileBytes()) return;
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

  private editorView(editor: Editor): EditorView | null {
    return (editor as unknown as { cm?: EditorView }).cm ?? null;
  }

  // Regions wrapped in %%protect%% ... %%/protect%% belong to the user alone:
  // whatever a collaborator wrote inside them is folded back to the user's
  // version before merging or proposing.
  private applyProtectedRegions(buffer: string, theirs: string): string {
    const re = /%%protect%%([\s\S]*?)%%\/protect%%/g;
    const mineBlocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(buffer)) !== null) mineBlocks.push(m[1]);
    if (mineBlocks.length === 0) return theirs;

    let i = 0;
    let touched = false;
    const out = theirs.replace(re, (whole, inner: string) => {
      if (i >= mineBlocks.length) return whole;
      const mine = mineBlocks[i++];
      if (inner !== mine) touched = true;
      return `%%protect%%${mine}%%/protect%%`;
    });
    if (touched) this.log("a protected section was preserved against an external edit");
    return out;
  }

  private async onDiskChange(af: TAbstractFile) {
    if (!(af instanceof TFile) || af.extension !== "md") return;
    if (af.stat.size > this.maxFileBytes()) return;

    // The chat and audit notes are plugin infrastructure, not co-edited prose.
    if (af.path === this.settings.chatPath) {
      this.selfWrites.delete(af.path);
      this.refreshPanel();
      return;
    }
    if (af.path === this.settings.auditLogPath) {
      this.selfWrites.delete(af.path);
      return;
    }

    // Our own guarded writes are not external edits.
    if (this.selfWrites.delete(af.path)) {
      this.shadows.set(af.path, await this.app.vault.cachedRead(af));
      return;
    }

    const mode = this.modeFor(af.path);
    const disk = await this.app.vault.cachedRead(af);
    const editor = this.findEditorFor(af.path);

    if (!editor || mode === "off") {
      // Keep an un-reviewed proposal current with the newest disk content, so
      // a later approval never resurrects an outdated version.
      const pend = this.pending.get(af.path);
      if (pend && editor === null) {
        pend.theirs = disk;
        void this.saveSettings();
        return;
      }
      // Approval mode applies to CLOSED files too: an external edit to a note
      // that is not open must still become a reviewable proposal, or it would
      // slip in silently. The last content we saw for the file is the base.
      const prev = this.shadows.get(af.path);
      if (
        mode === "approve" &&
        editor === null &&
        prev !== undefined &&
        prev !== disk
      ) {
        const who = await this.collaboratorName();
        const guarded = this.applyProtectedRegions(prev, disk);
        this.pending.set(af.path, { theirs: guarded, base: prev, collaborator: who });
        void this.saveSettings();
        this.announcePending(af.path, who);
        this.log(`${who} proposed an edit to ${af.path} (file closed)`);
        return; // shadow stays at the base until the user decides
      }
      if (mode === "approve" && editor === null && prev === undefined) {
        const who = await this.collaboratorName();
        new Notice(
          `AI Co-Editor: ${who} edited "${af.path}" before it had a baseline; the edit applied without review.`
        );
        this.log(`${who} edited ${af.path} without review (no baseline yet)`);
      }
      this.shadows.set(af.path, disk);
      return;
    }

    const buffer = editor.getValue();
    if (buffer === disk) {
      this.shadows.set(af.path, disk);
      return;
    }

    const base = this.shadows.get(af.path) ?? buffer;
    const who = await this.collaboratorName();
    const guarded = this.applyProtectedRegions(buffer, disk);

    if (mode === "approve") {
      this.pending.set(af.path, { theirs: guarded, base, collaborator: who });
      void this.saveSettings();
      this.announcePending(af.path, who);
      this.refreshInlineProposals(af.path);
      this.log(`${who} proposed an edit to ${af.path}`);
      return;
    }

    // Automatic mode: snapshot, merge, mark, audit.
    await this.snapshots.save(af.path, buffer);
    const { merged, conflicts } = merge3(base, buffer, guarded);
    this.applyMinimalEdit(editor, merged);
    this.markExternalChanges(editor, buffer, merged, this.slotFor(who));
    this.shadows.set(af.path, merged);
    await this.persistAllMarks();
    await this.appendAudit(who, af.path, buffer, merged);

    const time = new Date().toLocaleTimeString();
    if (conflicts > 0) {
      this.setStatus(`merged with ${conflicts} conflict(s) at ${time} — kept your text`);
      new Notice(
        `Live Co-Edit: ${conflicts} overlapping edit(s) — your version was kept.`
      );
    } else {
      this.setStatus(`merged edit from ${who} at ${time}`);
    }
    this.log(`${who} edited ${af.path} (applied)`);
  }

  // ---- Approval flow --------------------------------------------------------

  pendingPaths(): string[] {
    return [...this.pending.keys()];
  }

  private announcePending(path: string, who: string) {
    this.setStatus(
      `${this.pending.size} pending edit${this.pending.size === 1 ? "" : "s"} — review to apply`
    );
    this.pendingNotices.get(path)?.hide();
    const frag = createFragment();
    const div = frag.createDiv();
    div.setText(`${who} proposed an edit to "${path}" — `);
    const link = div.createEl("a", { text: "review" });
    link.addEventListener("click", () => this.openReview(path));
    const notice = new Notice(frag, 0);
    this.pendingNotices.set(path, notice);
    this.refreshPanel();
  }

  private dropPending(path: string) {
    this.pending.delete(path);
    this.reviewCache.delete(path);
    void this.saveSettings();
    this.refreshInlineProposals(path);
    this.pendingNotices.get(path)?.hide();
    this.pendingNotices.delete(path);
    if (this.pending.size === 0) this.setStatus("ready");
    this.refreshPanel();
  }

  openReview(path: string) {
    new ReviewModal(this.app, this, path).open();
  }

  getReviewData(
    path: string
  ): { segments: Segment[]; buffer: string; collaborator: string } | null {
    const pend = this.pending.get(path);
    if (!pend) return null;
    const editor = this.findEditorFor(path);
    let buffer = editor ? editor.getValue() : pend.base;
    // After a restart the buffer may already hold the proposed text (the
    // proposal was written to disk before quitting). Review against the base,
    // or the diff would appear empty and approval meaningless.
    if (buffer === pend.theirs) buffer = pend.base;

    const key = `${hashStr(buffer)}:${hashStr(pend.theirs)}:${hashStr(pend.base)}`;
    const cached = this.reviewCache.get(path);
    if (cached && cached.key === key) return cached.data;

    const data = {
      segments: merge3Segments(pend.base, buffer, pend.theirs).segments,
      buffer,
      collaborator: pend.collaborator,
    };
    this.reviewCache.set(path, { key, data });
    return data;
  }

  async applyReviewed(path: string, finalText: string, accepted: number, total: number) {
    const pend = this.pending.get(path);
    const who = pend?.collaborator ?? "collaborator";
    const editor = this.findEditorFor(path);
    const before = editor ? editor.getValue() : pend?.base ?? "";

    await this.snapshots.save(path, before);

    if (editor) {
      this.applyMinimalEdit(editor, finalText);
      this.markExternalChanges(editor, before, finalText, this.slotFor(who));
    } else {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.selfModify(f, finalText);
    }
    this.shadows.set(path, finalText);
    this.dropPending(path);
    await this.persistAllMarks();
    await this.appendAudit(who, path, before, finalText);
    this.log(`you accepted ${accepted}/${total} changes from ${who} in ${path}`);
    this.setStatus(`applied review at ${new Date().toLocaleTimeString()}`);
  }

  async rejectPending(path: string) {
    const pend = this.pending.get(path);
    const editor = this.findEditorFor(path);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (editor && f instanceof TFile) {
      const buffer = editor.getValue();
      await this.selfModify(f, buffer);
      this.shadows.set(path, buffer);
    } else if (pend && f instanceof TFile) {
      // File not open: rejecting must restore the pre-edit content on disk,
      // otherwise the "rejected" edit silently survives.
      await this.selfModify(f, pend.base);
      this.shadows.set(path, pend.base);
    }
    this.dropPending(path);
    this.log(`you rejected the edit from ${pend?.collaborator ?? "collaborator"} in ${path}`);
    this.setStatus(`rejected external edit at ${new Date().toLocaleTimeString()}`);
  }

  private maxFileBytes(): number {
    return (this.settings.maxFileKB || DEFAULT_MAX_FILE_KB) * 1000;
  }

  private async pollCollabStatus() {
    try {
      const p = `${this.app.vault.configDir}/live-coedit-status.json`;
      if (!(await this.app.vault.adapter.exists(p))) return;
      const parsed = JSON.parse(await this.app.vault.adapter.read(p)) as {
        name?: string;
        state?: string;
        ts?: number;
      };
      const next = {
        name: parsed.name ?? "collaborator",
        state: parsed.state ?? "idle",
        ts: parsed.ts ?? 0,
      };
      // Refresh when the VISIBLE state flips, including expiry of a stale
      // "working" signal from a crashed agent.
      const visible =
        next.state === "working" && Date.now() - next.ts < 180_000;
      const changed =
        visible !== this.lastStatusVisible ||
        this.collabStatus?.name !== next.name;
      this.collabStatus = next;
      this.lastStatusVisible = visible;
      if (changed) this.refreshPanel();
    } catch {
      // unreadable signal file: ignore
    }
  }

  // Quick summary of a pending proposal for the panel row.
  pendingSummary(path: string): string | null {
    const data = this.getReviewData(path);
    if (!data) return null;
    let changes = 0;
    let added = 0;
    let removed = 0;
    for (const seg of data.segments) {
      if (seg.kind !== "proposal") continue;
      changes++;
      for (const tok of diffWords(seg.mine.join("\n"), seg.theirs.join("\n"))) {
        const words = tok.text.trim().split(/\s+/).filter(Boolean).length;
        if (tok.kind === "add") added += words;
        else if (tok.kind === "del") removed += words;
      }
    }
    return `${changes} change${changes === 1 ? "" : "s"} · +${added}/−${removed} words`;
  }

  // Accept everything in a pending proposal without opening the dialog.
  // Conflicting regions (both sides changed the same lines) keep the user's
  // version — silently discarding the user's typing is never acceptable.
  async acceptAllPending(path: string) {
    const data = this.getReviewData(path);
    if (!data) return;
    const proposals = data.segments.filter(
      (s): s is Extract<Segment, { kind: "proposal" }> => s.kind === "proposal"
    );
    const choices = proposals.map((p) => !p.conflict);
    const skipped = choices.filter((c) => !c).length;
    const finalText = composeSegments(data.segments, choices);
    await this.applyReviewed(
      path,
      finalText,
      choices.length - skipped,
      choices.length
    );
    if (skipped > 0) {
      new Notice(
        `${skipped} conflicting change(s) kept your version — open Review to compare.`
      );
    }
  }

  // ---- Chat -------------------------------------------------------------------

  chatDraft = "";

  async chatMessages(): Promise<ChatMessage[]> {
    const f = this.app.vault.getAbstractFileByPath(this.settings.chatPath);
    if (!(f instanceof TFile)) return [];
    const content = await this.app.vault.cachedRead(f);
    const out: ChatMessage[] = [];
    for (const line of content.split("\n")) {
      const m = line.match(/^- \*\*(.+?)\*\* \((.+?)\): (.*)$/);
      if (m) {
        // "me → claude" means the message is addressed to one collaborator.
        const [name, target] = m[1].split(" → ");
        out.push({ name, target, time: m[2], text: m[3] });
      }
    }
    return out.slice(-12);
  }

  chatArchivePath(): string {
    return this.settings.chatPath.replace(/\.md$/, " archive.md");
  }

  // On startup, move last session's messages into the archive so the panel
  // opens clean. History stays one click away.
  private async archiveChatIfNeeded() {
    if (!this.settings.clearChatOnStartup) return;
    const f = this.app.vault.getAbstractFileByPath(this.settings.chatPath);
    if (!(f instanceof TFile)) return;
    const content = await this.app.vault.cachedRead(f);
    const lines = content.split("\n").filter((l) => /^- \*\*/.test(l));
    if (lines.length === 0) return;

    const archPath = this.chatArchivePath();
    const stamp = new Date().toLocaleString();
    const chunk = `\n## Session ended ${stamp}\n\n${lines.join("\n")}\n`;
    const arch = this.app.vault.getAbstractFileByPath(archPath);
    this.selfWrites.add(archPath);
    if (arch instanceof TFile) {
      await this.app.vault.process(arch, (d) => d + chunk);
    } else {
      await this.app.vault.create(archPath, `# Co-edit chat archive\n${chunk}`);
    }
    this.selfWrites.add(this.settings.chatPath);
    await this.app.vault.modify(f, "# Co-edit chat\n\n");
    this.refreshPanel();
  }

  async clearChat() {
    const path = this.settings.chatPath;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      this.selfWrites.add(path);
      await this.app.vault.modify(existing, "# Co-edit chat\n\n");
    }
    this.refreshPanel();
  }

  // Manually register a collaborator (before its bridge exists) so it can be
  // targeted from the switcher.
  addCollaborator(name: string) {
    const clean = name.trim();
    if (!clean || clean === "everyone") return;
    this.slotFor(clean);
    this.refreshPanel();
  }

  // Switch which collaborator is being addressed; also signalled on disk so
  // bridge processes know whether they are the intended recipient.
  async setActiveCollaborator(name: string) {
    this.settings.activeCollaborator = name;
    await this.saveSettings();
    await this.app.vault.adapter.write(
      `${this.app.vault.configDir}/live-coedit-target.json`,
      JSON.stringify({ target: name, ts: Date.now() })
    );
    this.refreshPanel();
  }

  async sendChat(text: string) {
    const clean = text.trim();
    if (!clean) return;
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const target = this.settings.activeCollaborator;
    const author =
      target && target !== "everyone"
        ? `${this.settings.userName} → ${target}`
        : this.settings.userName;
    const entry = `- **${author}** (${time}): ${clean}\n`;
    const path = this.settings.chatPath;
    const existing = this.app.vault.getAbstractFileByPath(path);
    this.selfWrites.add(path);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (data) => data + entry);
    } else {
      await this.app.vault.create(path, `# Co-edit chat\n\n${entry}`);
    }
    this.chatDraft = "";
    this.refreshPanel();
  }

  // Selection-scoped edit requests: quote the passage into the chat together
  // with its location, so the collaborator edits exactly that spot.
  private askAboutSelection(editor: Editor, view: MarkdownView) {
    // Derive the selected text from the document by offsets rather than
    // trusting editor.getSelection(): other plugins can and do patch that
    // method, and a non-string return here once produced "[object Object]".
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    const selection = String(editor.getValue()).slice(from, to);
    if (!view.file || !selection.trim()) {
      new Notice("Select some text first.");
      return;
    }
    this.openAskModal(view, selection, from, to);
  }

  private openAskModal(
    view: MarkdownView,
    selection: string,
    from?: number,
    to?: number
  ) {
    const file = view.file;
    if (!file) return;
    new AskModal(this.app, selection, (instruction) => {
      const escaped = selection.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
      const quoted =
        escaped.length > 400
          ? `${escaped.slice(0, 180)} […] ${escaped.slice(-180)}`
          : escaped;
      const loc = from !== undefined && to !== undefined ? ` [${from}-${to}]` : "";
      void this.sendChat(
        `✂️ ${file.path}${loc}: «${quoted}» → ${instruction}`
      );
      new Notice("Sent to your collaborator.");
    }).open();
  }

  // ---- Floating "Ask collaborator" button -------------------------------------

  private askButtons = new Map<Document, HTMLButtonElement>();

  private askButtonTimers = new Map<Document, number>();

  private setupAskButton(doc: Document) {
    // Debounced: the button appears only once the selection has been stable
    // for a moment, so it never interferes with active editing.
    this.registerDomEvent(doc, "selectionchange", () => {
      this.hideAskButton(doc);
      const prev = this.askButtonTimers.get(doc);
      if (prev !== undefined) window.clearTimeout(prev);
      this.askButtonTimers.set(
        doc,
        window.setTimeout(() => this.updateAskButton(doc), 600)
      );
    });
    // Typing, deleting, or scrolling always dismisses it immediately.
    this.registerDomEvent(doc, "keydown", () => this.hideAskButton(doc), {
      capture: true,
    });
    this.registerDomEvent(doc, "wheel", () => this.hideAskButton(doc), {
      capture: true,
      passive: true,
    });
  }

  private markdownViewContaining(node: Node): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.containerEl.contains(node)) {
        return view;
      }
    }
    return null;
  }

  private getAskButton(doc: Document): HTMLButtonElement {
    let btn = this.askButtons.get(doc);
    if (btn) return btn;
    btn = doc.createElement("button");
    btn.className = "live-coedit-askbtn";
    btn.setText("Ask AI");
    // pointerdown + preventDefault keeps the selection alive.
    btn.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.onAskButton(doc);
    });
    doc.body.appendChild(btn);
    this.askButtons.set(doc, btn);
    return btn;
  }

  private hideAskButton(doc: Document) {
    this.askButtons.get(doc)?.removeClass("is-visible");
  }

  private updateAskButton(doc: Document) {
    if (this.settings.askButtonMode === "off") return;
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.hideAskButton(doc);
      return;
    }
    const range = sel.getRangeAt(0);
    const view = this.markdownViewContaining(range.startContainer);
    if (!view || !view.file) {
      this.hideAskButton(doc);
      return;
    }
    // In editing mode the context menu covers this; the floating button would
    // sit over text the user is actively working on.
    if (this.settings.askButtonMode === "reading" && view.getMode() === "source") {
      this.hideAskButton(doc);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideAskButton(doc);
      return;
    }
    const btn = this.getAskButton(doc);
    btn.addClass("is-visible");
    // Sit clearly above the selection, never on it.
    btn.style.top = `${Math.max(8, rect.top - 44)}px`;
    btn.style.left = `${Math.max(8, rect.left + rect.width / 2 - 60)}px`;
  }

  private onAskButton(doc: Document) {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    // Extract the text from the DOM range itself: Selection.toString() can be
    // patched by other plugins and once returned an object here.
    const range0 = sel.getRangeAt(0);
    let text = range0.cloneContents().textContent ?? "";
    if (!text.trim()) {
      const fallback = sel.toString();
      text = typeof fallback === "string" ? fallback : "";
    }
    if (!text.trim()) return;
    const view = this.markdownViewContaining(range0.startContainer);
    if (!view || !view.file) return;

    let from: number | undefined;
    let to: number | undefined;
    if (view.getMode() === "source" && view.editor.somethingSelected()) {
      from = view.editor.posToOffset(view.editor.getCursor("from"));
      to = view.editor.posToOffset(view.editor.getCursor("to"));
    } else {
      // Reading view: locate the selected passage in the source if possible.
      const idx = view.editor.getValue().indexOf(text);
      if (idx >= 0) {
        from = idx;
        to = idx + text.length;
      }
    }
    this.hideAskButton(doc);
    this.openAskModal(view, text, from, to);
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
    this.openReview(path);
  }

  // ---- In-document track changes -----------------------------------------------

  // Paint the pending proposal into the editor: struck deletions, green ghost
  // insertions, each with accept/reject buttons.
  refreshInlineProposals(path: string) {
    const editor = this.findEditorFor(path);
    const view = editor ? this.editorView(editor) : null;
    if (!editor || !view) return;

    const data = this.settings.inlineProposals ? this.getReviewData(path) : null;
    if (!data) {
      view.dispatch({ effects: clearInlineProposals.of(null) });
      return;
    }
    // If the editor currently shows the proposed text itself (it reached disk
    // while the note was closed), swap the visible content back to the user's
    // version so the proposal can render as reviewable ghosts right here.
    if (editor.getValue() !== data.buffer) {
      const pend = this.pending.get(path);
      if (
        pend &&
        editor.getValue() === pend.theirs &&
        pend.base !== pend.theirs
      ) {
        this.applyMinimalEdit(editor, pend.base);
        this.shadows.set(path, pend.base);
      } else {
        view.dispatch({ effects: clearInlineProposals.of(null) });
        return;
      }
    }

    const dels: InlineDel[] = [];
    const adds: InlineAdd[] = [];
    let bufferOffset = 0;
    let idx = 0;
    for (const seg of data.segments) {
      if (seg.kind === "plain") {
        for (const l of seg.lines) bufferOffset += l.length + 1;
        continue;
      }
      const mineText = seg.mine.join("\n");
      const theirsText = seg.theirs.join("\n");
      let off = bufferOffset;
      let hasAdd = false;
      let lastDelEnd = bufferOffset;
      for (const tok of diffWords(mineText, theirsText)) {
        if (tok.kind === "same") {
          off += tok.text.length;
        } else if (tok.kind === "del") {
          dels.push({ from: off, to: off + tok.text.length, proposalIndex: idx });
          off += tok.text.length;
          lastDelEnd = off;
        } else {
          adds.push({ pos: off, text: tok.text, proposalIndex: idx });
          hasAdd = true;
        }
      }
      // Deletion-only proposals still need their accept and reject buttons.
      if (!hasAdd) {
        adds.push({ pos: lastDelEnd, text: "", proposalIndex: idx });
      }
      bufferOffset += mineText.length + 1;
      idx++;
    }

    view.dispatch({
      effects: setInlineProposals.of({
        dels,
        adds,
        onResolve: (i, accept) => void this.resolveProposal(path, i, accept),
      }),
    });
  }

  // True when the note is open and the proposal is rendering as in-text
  // ghosts, so other surfaces can stay out of the way.
  inlineActiveFor(path: string): boolean {
    if (!this.settings.inlineProposals || !this.pending.has(path)) return false;
    const editor = this.findEditorFor(path);
    if (!editor) return false;
    const data = this.getReviewData(path);
    return !!data && editor.getValue() === data.buffer;
  }

  // Accept or reject ONE change from a pending proposal, in place.
  async resolveProposal(path: string, index: number, accept: boolean) {
    const pend = this.pending.get(path);
    const data = this.getReviewData(path);
    const editor = this.findEditorFor(path);
    if (!pend || !data || !editor) return;

    const proposals = data.segments.filter((s) => s.kind === "proposal");
    if (index < 0 || index >= proposals.length) return;

    if (accept) {
      // Compose the document with exactly this hunk taken, using the same
      // engine as the review dialog. Never hand-rolled offsets: an earlier
      // version ate a newline that way.
      const choices = proposals.map((_, k) => k === index);
      const newBuffer = composeSegments(data.segments, choices);
      const before = editor.getValue();
      await this.snapshots.save(path, before);
      this.applyMinimalEdit(editor, newBuffer);
      this.markExternalChanges(
        editor,
        before,
        newBuffer,
        this.slotFor(pend.collaborator)
      );
      await this.appendAudit(pend.collaborator, path, before, newBuffer);
      this.log(`you accepted 1 change from ${pend.collaborator} in ${path}`);
    } else {
      // Fold this hunk back to the user's version inside the proposal.
      const choices = proposals.map((_, k) => k !== index);
      pend.theirs = composeSegments(data.segments, choices);
      this.log(`you rejected 1 change from ${pend.collaborator} in ${path}`);
    }

    this.reviewCache.delete(path);
    // If nothing is left to review, the proposal is settled.
    const fresh = this.getReviewData(path);
    const remaining = fresh
      ? fresh.segments.filter((s) => s.kind === "proposal").length
      : 0;
    if (remaining === 0) {
      this.dropPending(path);
      this.setStatus("all changes resolved");
    } else {
      void this.saveSettings();
      this.refreshInlineProposals(path);
    }
    this.refreshPanel();
  }

  // ---- Highlights -------------------------------------------------------------

  private markExternalChanges(
    editor: Editor,
    prev: string,
    next: string,
    slot: number
  ) {
    const view = this.editorView(editor);
    if (!view) return;

    const prevLines = prev.split("\n");
    const nextLen: number[] = next.split("\n").map((l) => l.length + 1);
    const hunks = diffLines(prevLines, next.split("\n"));
    if (hunks.length === 0) return;

    // Word-level precision: inside each changed line-hunk, mark only the
    // words that are actually new — a one-word tweak in a long paragraph
    // highlights one word, not the paragraph.
    const ranges: MarkRange[] = [];
    let prevLine = 0;
    let nextOffset = 0;
    let nextLine = 0;
    for (const h of hunks) {
      for (let k = prevLine; k < h.baseStart; k++) {
        nextOffset += nextLen[nextLine];
        nextLine++;
      }
      const from = nextOffset;
      for (let k = 0; k < h.lines.length; k++) {
        nextOffset += nextLen[nextLine];
        nextLine++;
      }
      const hunkEnd = h.lines.length > 0 ? nextOffset - 1 : nextOffset;

      if (hunkEnd > from) {
        const prevText = prevLines.slice(h.baseStart, h.baseEnd).join("\n");
        const nextText = h.lines.join("\n");
        let off = from;
        for (const tok of diffWords(prevText, nextText)) {
          if (tok.kind === "del") continue; // not present in `next`
          if (tok.kind === "add" && tok.text.trim().length > 0) {
            ranges.push({
              from: off,
              to: Math.min(off + tok.text.length, next.length),
            });
          }
          off += tok.text.length;
        }
      }
      prevLine = h.baseEnd;
    }

    if (ranges.length > 0) {
      view.dispatch({ effects: addExternalMarks.of({ ranges, slot }) });
    }
  }

  // Dismiss a single collaborator mark (leave the rest).
  dismissMark(path: string, from: number, to: number) {
    const editor = this.findEditorFor(path);
    const view = editor ? this.editorView(editor) : null;
    if (view) {
      view.dispatch({ effects: removeMarkRange.of({ from, to }) });
      void this.persistAllMarks();
      this.refreshPanel();
    }
  }

  clearHighlightsFor(path: string) {
    const editor = this.findEditorFor(path);
    const view = editor ? this.editorView(editor) : null;
    if (view) view.dispatch({ effects: clearExternalMarks.of(null) });
    delete this.highlights[path];
    void this.saveSettings();
    this.setStatus("highlights cleared");
    this.refreshPanel();
  }

  marksInFile(path: string): MarkListing[] {
    const editor = this.findEditorFor(path);
    const view = editor ? this.editorView(editor) : null;
    if (!editor || !view) return [];
    const text = editor.getValue();
    return readMarks(view).map((m) => {
      const line = editor.offsetToPos(m.from).line;
      const raw = text.slice(m.from, Math.min(m.to, m.from + 42));
      return {
        from: m.from,
        to: m.to,
        line,
        excerpt: raw.replace(/\n/g, " ⏎ ") + (m.to - m.from > 42 ? "…" : ""),
        slot: m.slot,
        name: this.nameForSlot(m.slot),
      };
    });
  }

  // ---- Comments -----------------------------------------------------------------

  commentsInFile(path: string): CoComment[] {
    const editor = this.findEditorFor(path);
    if (!editor) return [];
    return scanComments(editor.getValue());
  }

  // Re-locate a comment at action time: the note may have changed since the
  // panel rendered, so a stale index could hit the wrong comment.
  private locateComment(
    path: string,
    anchor: { from: number; text: string }
  ): { editor: Editor; c: CoComment } | null {
    const editor = this.findEditorFor(path);
    if (!editor) return null;
    const comments = scanComments(editor.getValue());
    const c =
      comments.find((x) => x.from === anchor.from && x.text === anchor.text) ??
      comments.find((x) => x.text === anchor.text) ??
      null;
    return c ? { editor, c } : null;
  }

  async dismissComment(path: string, anchor: { from: number; text: string }) {
    const hit = this.locateComment(path, anchor);
    if (!hit) {
      new Notice("That comment is no longer where it was.");
      return;
    }
    const { editor, c } = hit;
    editor.replaceRange("", editor.offsetToPos(c.from), editor.offsetToPos(c.to));
    this.log(`you dismissed a comment from ${c.name} in ${path}`);
  }

  replyToComment(path: string, anchor: { from: number; text: string }) {
    new ReplyModal(this.app, (text) => {
      const hit = this.locateComment(path, anchor);
      if (!hit) {
        new Notice("That comment is no longer where it was.");
        return;
      }
      const insert = ` %%${this.settings.userName}: ${text}%%`;
      hit.editor.replaceRange(insert, hit.editor.offsetToPos(hit.c.to));
      this.log(`you replied to ${hit.c.name} in ${path}`);
      this.refreshPanel();
    }).open();
  }

  // ---- Snapshots ------------------------------------------------------------------

  async snapshotList(path: string): Promise<SnapshotInfo[]> {
    return this.snapshots.list(path);
  }

  openHistory(path: string) {
    new HistoryModal(this.app, this, path).open();
  }

  async snapshotRead(snap: SnapshotInfo): Promise<string> {
    return this.snapshots.read(snap);
  }

  async restoreSnapshot(path: string, snap: SnapshotInfo) {
    const content = await this.snapshots.read(snap);
    const editor = this.findEditorFor(path);
    if (editor) {
      this.applyMinimalEdit(editor, content);
    } else {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.selfModify(f, content);
    }
    this.shadows.set(path, content);
    this.dropPending(path);
    this.log(`you restored ${path} to ${new Date(snap.ts).toLocaleString()}`);
    new Notice("Snapshot restored.");
  }

  private async restoreLatestSnapshot() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Open a markdown file first.");
      return;
    }
    const snaps = await this.snapshots.list(file.path);
    if (snaps.length === 0) {
      new Notice("No snapshots for this file.");
      return;
    }
    await this.restoreSnapshot(file.path, snaps[0]);
  }

  // ---- Audit log --------------------------------------------------------------------

  private async appendAudit(
    who: string,
    path: string,
    before: string,
    after: string
  ) {
    if (!this.settings.auditLog) return;
    if (path === this.settings.auditLogPath) return;

    let added = 0;
    let removed = 0;
    for (const h of diffLines(before.split("\n"), after.split("\n"))) {
      added += h.lines.length;
      removed += h.baseEnd - h.baseStart;
    }
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const entry = `- ${stamp} — **${who}** → [[${path.replace(/\.md$/, "")}]] (+${added}/−${removed} lines)\n`;

    const logPath = this.settings.auditLogPath;
    const existing = this.app.vault.getAbstractFileByPath(logPath);
    this.selfWrites.add(logPath);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (data) => data + entry);
    } else {
      await this.app.vault.create(logPath, `# Co-edit log\n\n${entry}`);
    }
  }

  // ---- Editor mechanics -----------------------------------------------------

  private async selfModify(file: TFile, content: string) {
    this.selfWrites.add(file.path);
    // Failsafe: if the modify event never fires (write error, race), the
    // guard must not linger and swallow a future genuine external edit.
    window.setTimeout(() => this.selfWrites.delete(file.path), 3000);
    await this.app.vault.modify(file, content);
  }

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

  async jumpTo(path: string, offset: number) {
    await this.app.workspace.openLinkText(path, "", false);
    const editor = this.findEditorFor(path);
    if (editor) {
      const pos = editor.offsetToPos(Math.min(offset, editor.getValue().length));
      editor.setCursor(pos);
      editor.scrollIntoView({ from: pos, to: pos }, true);
    }
  }

  // Add the "Open co-edit panel" action to each markdown view's own toolbar.
  private viewsWithAction = new WeakSet<MarkdownView>();

  private addViewActions() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && !this.viewsWithAction.has(view)) {
        this.viewsWithAction.add(view);
        view.addAction("users", "Open co-edit panel", () => void this.openPanel());
      }
    }
  }

  private async openPanel() {
    const existing = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: PANEL_VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    }
  }

  refreshPanel() {
    for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof CoEditPanelView) void view.refresh();
    }
  }

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

// ---- History browser ----------------------------------------------------------

class HistoryModal extends Modal {
  constructor(
    app: App,
    private plugin: LiveCoEditPlugin,
    private path: string
  ) {
    super(app);
  }

  private renderDiffInto(el: HTMLElement, before: string, after: string) {
    const box = el.createDiv({ cls: "live-coedit-diff live-coedit-diff-prose" });
    for (const tok of diffWords(before, after)) {
      if (tok.kind === "same") {
        // Collapse long unchanged runs.
        const words = tok.text.split(/(\s+)/);
        if (words.filter((w) => w.trim()).length > 14) {
          box.createSpan({ text: words.slice(0, 8).join("") });
          box.createSpan({ cls: "live-coedit-skip-inline", text: " ⋯ " });
          box.createSpan({ text: words.slice(-8).join("") });
        } else {
          box.createSpan({ text: tok.text });
        }
      } else if (tok.kind === "del") {
        box.createSpan({ cls: "live-coedit-w-del", text: tok.text });
      } else {
        box.createSpan({ cls: "live-coedit-w-add", text: tok.text });
      }
    }
  }

  async onOpen() {
    this.modalEl.addClass("live-coedit-modal");
    const name = this.path.split("/").pop() ?? this.path;
    this.titleEl.setText(`History: ${name}`);

    const snaps = await this.plugin.snapshotList(this.path);
    if (snaps.length === 0) {
      this.contentEl.setText("No restore points yet for this file.");
      return;
    }
    const f = this.app.vault.getAbstractFileByPath(this.path);
    const current = f instanceof TFile ? await this.app.vault.cachedRead(f) : "";

    for (const snap of snaps.slice(0, 10)) {
      const row = this.contentEl.createDiv({ cls: "live-coedit-row" });
      row.createSpan({
        cls: "live-coedit-file",
        text: new Date(snap.ts).toLocaleString(),
      });
      const diffBtn = row.createEl("button", { text: "Diff vs now", cls: "live-coedit-smallbtn" });
      const restoreBtn = row.createEl("button", { text: "Restore", cls: "live-coedit-smallbtn mod-warning" });
      const holder = this.contentEl.createDiv();
      let shown = false;
      diffBtn.addEventListener("click", () => {
        if (shown) {
          holder.empty();
          shown = false;
          return;
        }
        void this.plugin.snapshotRead(snap).then((content) => {
          holder.empty();
          this.renderDiffInto(holder, content, current);
          shown = true;
        });
      });
      restoreBtn.addEventListener("click", () => {
        void this.plugin.restoreSnapshot(this.path, snap);
        this.close();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Review dialog (per-hunk accept/reject + conflict picks) -----------------

class ReviewModal extends Modal {
  private plugin: LiveCoEditPlugin;
  private path: string;
  private choices: boolean[] = [];
  private checkboxes: HTMLInputElement[] = [];

  constructor(app: App, plugin: LiveCoEditPlugin, path: string) {
    super(app);
    this.plugin = plugin;
    this.path = path;
  }

  private applySelection() {
    const fresh = this.plugin.getReviewData(this.path);
    if (fresh) {
      const freshProposals = fresh.segments.filter(
        (s) => s.kind === "proposal"
      ).length;
      if (freshProposals !== this.choices.length) {
        new Notice("The note changed while reviewing — please look again.");
        this.close();
        this.plugin.openReview(this.path);
        return;
      }
      const finalText = composeSegments(fresh.segments, this.choices);
      const accepted = this.choices.filter(Boolean).length;
      void this.plugin.applyReviewed(
        this.path,
        finalText,
        accepted,
        this.choices.length
      );
    }
    this.close();
  }

  // Render prose with inline word-level track changes: deleted words struck
  // red, inserted words green — like reviewing edits in a word processor.
  private renderTrackChanges(parent: HTMLElement, before: string, after: string) {
    const para = parent.createDiv({ cls: "live-coedit-prose" });
    for (const tok of diffWords(before, after)) {
      if (tok.kind === "same") para.createSpan({ text: tok.text });
      else if (tok.kind === "del")
        para.createSpan({ cls: "live-coedit-w-del", text: tok.text });
      else para.createSpan({ cls: "live-coedit-w-add", text: tok.text });
    }
  }

  onOpen() {
    const { contentEl, titleEl, modalEl } = this;
    modalEl.addClass("live-coedit-modal");
    const data = this.plugin.getReviewData(this.path);
    if (!data) {
      titleEl.setText("Review");
      contentEl.setText("This edit is no longer pending.");
      return;
    }

    const proposals = data.segments.filter((s) => s.kind === "proposal");
    titleEl.setText(
      `${data.collaborator} suggests ${proposals.length} change${proposals.length === 1 ? "" : "s"}`
    );
    this.choices = proposals.map((p) =>
      p.kind === "proposal" ? !p.conflict : true
    );
    this.checkboxes = [];

    // Quick toggles when there are several changes to wade through.
    if (proposals.length > 2) {
      const toggles = contentEl.createDiv({ cls: "live-coedit-toggles" });
      const all = toggles.createEl("button", { text: "Accept all" });
      all.addEventListener("click", () => {
        this.checkboxes.forEach((cb, i) => {
          cb.checked = true;
          this.choices[parseInt(cb.dataset.idx ?? String(i), 10)] = true;
        });
      });
      const none = toggles.createEl("button", { text: "Accept none" });
      none.addEventListener("click", () => {
        this.checkboxes.forEach((cb, i) => {
          cb.checked = false;
          this.choices[parseInt(cb.dataset.idx ?? String(i), 10)] = false;
        });
      });
    }

    const box = contentEl.createDiv({ cls: "live-coedit-diff live-coedit-diff-prose" });
    let p = 0;
    // Track each proposal's char offset in the current buffer so a click on
    // a hunk can jump straight to that spot in the note.
    let bufferOffset = 0;
    for (let i = 0; i < data.segments.length; i++) {
      const seg = data.segments[i];
      if (seg.kind === "plain") {
        // One line of surrounding context, muted.
        const prevIsChange = i > 0;
        const nextIsChange = i < data.segments.length - 1;
        if (prevIsChange && seg.lines.length > 0) {
          box.createDiv({ cls: "live-coedit-context", text: seg.lines[0] });
        }
        if (seg.lines.length > 2 && prevIsChange && nextIsChange) {
          box.createDiv({ cls: "live-coedit-skip", text: `⋯` });
        }
        if (nextIsChange && seg.lines.length > 1) {
          box.createDiv({
            cls: "live-coedit-context",
            text: seg.lines[seg.lines.length - 1],
          });
        }
        for (const l of seg.lines) bufferOffset += l.length + 1;
        continue;
      }

      const idx = p++;
      const hunkOffset = bufferOffset;
      for (const l of seg.mine) bufferOffset += l.length + 1;
      const wrap = box.createDiv({ cls: "live-coedit-hunk" });
      wrap.setAttribute("title", "Click to jump to this spot in the note");
      wrap.addEventListener("click", (evt) => {
        // Don't hijack clicks meant for the checkboxes and radios.
        const t = evt.target as HTMLElement | null;
        if (t && t.tagName === "INPUT") return;
        void this.plugin.jumpTo(this.path, hunkOffset);
      });
      const header = wrap.createDiv({ cls: "live-coedit-hunk-head" });

      if (seg.conflict) {
        header.createSpan({
          cls: "live-coedit-conflict-tag",
          text: "You both changed this — pick one",
        });
        const mineDiv = wrap.createDiv({ cls: "live-coedit-choice" });
        const mineRadio = mineDiv.createEl("input", { type: "radio" });
        mineRadio.name = `conflict-${idx}`;
        mineRadio.checked = true;
        mineDiv.createSpan({ text: " Keep yours:" });
        wrap.createDiv({ cls: "live-coedit-prose live-coedit-version", text: seg.mine.join("\n") });
        const theirsDiv = wrap.createDiv({ cls: "live-coedit-choice" });
        const theirsRadio = theirsDiv.createEl("input", { type: "radio" });
        theirsRadio.name = `conflict-${idx}`;
        theirsDiv.createSpan({ text: ` Take ${data.collaborator}'s:` });
        wrap.createDiv({ cls: "live-coedit-prose live-coedit-version", text: seg.theirs.join("\n") });
        mineRadio.addEventListener("change", () => (this.choices[idx] = false));
        theirsRadio.addEventListener("change", () => (this.choices[idx] = true));
      } else {
        const cb = header.createEl("input", { type: "checkbox" });
        cb.checked = true;
        cb.dataset.idx = String(idx);
        this.checkboxes.push(cb);
        const label = header.createSpan({ text: " Accept" });
        label.addClass("live-coedit-accept-label");
        cb.addEventListener("change", () => (this.choices[idx] = cb.checked));
        this.renderTrackChanges(wrap, seg.mine.join("\n"), seg.theirs.join("\n"));
      }
    }

    const buttons = contentEl.createDiv({ cls: "live-coedit-buttons" });
    const apply = buttons.createEl("button", { text: "Apply accepted changes (Enter)" });
    apply.addClass("mod-cta");
    apply.addEventListener("click", () => this.applySelection());
    // Enter applies from anywhere in the dialog.
    this.scope.register([], "Enter", (evt) => {
      evt.preventDefault();
      this.applySelection();
    });
    const reject = buttons.createEl("button", { text: "Reject all" });
    reject.addClass("mod-warning");
    reject.addEventListener("click", () => {
      void this.plugin.rejectPending(this.path);
      this.close();
    });
    const later = buttons.createEl("button", { text: "Decide later" });
    later.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Ask-about-selection input --------------------------------------------------

class AskModal extends Modal {
  private selection: string;
  private onDone: (instruction: string) => void;

  constructor(app: App, selection: string, onDone: (instruction: string) => void) {
    super(app);
    // Defensive: whatever arrives, the preview shows text, never an object.
    if (typeof selection === "string") {
      this.selection = selection;
    } else {
      console.warn(
        "AI Co-Editor: non-string selection reached AskModal:",
        typeof selection,
        selection
      );
      this.selection = "(could not capture the selected text; your instruction will still be sent)";
    }
    this.onDone = onDone;
  }

  onOpen() {
    this.titleEl.setText("Ask your AI collaborator");
    const preview = this.contentEl.createDiv({ cls: "live-coedit-ask-preview" });
    preview.setText(
      this.selection.length > 220
        ? this.selection.slice(0, 220) + "…"
        : this.selection
    );
    const input = this.contentEl.createEl("input", { type: "text" });
    input.addClass("live-coedit-reply-input");
    input.placeholder = "What should change here? e.g. tighten this, make the claim more cautious…";
    const submit = () => {
      const v = input.value.trim();
      if (v) this.onDone(v);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    const buttons = this.contentEl.createDiv({ cls: "live-coedit-buttons" });
    const ok = buttons.createEl("button", { text: "Send" });
    ok.addClass("mod-cta");
    ok.addEventListener("click", submit);
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Reply input --------------------------------------------------------------

class ReplyModal extends Modal {
  private onDone: (text: string) => void;

  constructor(app: App, onDone: (text: string) => void) {
    super(app);
    this.onDone = onDone;
  }

  onOpen() {
    this.titleEl.setText("Reply to comment");
    const input = this.contentEl.createEl("input", { type: "text" });
    input.addClass("live-coedit-reply-input");
    input.placeholder = "Your reply…";
    const submit = () => {
      const v = input.value.trim();
      if (v) this.onDone(v);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    const buttons = this.contentEl.createDiv({ cls: "live-coedit-buttons" });
    const ok = buttons.createEl("button", { text: "Reply" });
    ok.addClass("mod-cta");
    ok.addEventListener("click", submit);
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Settings -------------------------------------------------------------------

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
      .setName("External edits (default)")
      .setDesc(
        "Apply automatically: merge straight into your editor with collaborator highlights. Require approval: review each change (per-hunk) before it lands. Off: Obsidian's default behavior."
      )
      .addDropdown((dd) =>
        dd
          .addOption("auto", "Apply automatically")
          .addOption("approve", "Require my approval")
          .addOption("off", "Off")
          .setValue(this.plugin.settings.applyMode)
          .onChange(async (v) => {
            this.plugin.settings.applyMode = v as ApplyMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Per-folder rules")
      .setDesc(
        'One rule per line: "folder/path=mode" where mode is auto, approve, or off. The longest matching prefix wins. Example: Drafts=approve'
      )
      .addTextArea((ta) => {
        ta.setValue(
          this.plugin.settings.folderRules
            .map((r) => `${r.prefix}=${r.mode}`)
            .join("\n")
        ).onChange(async (v) => {
          const rules: FolderRule[] = [];
          for (const line of v.split("\n")) {
            const m = line.match(/^(.*?)=(auto|approve|off)\s*$/);
            if (m && m[1].trim()) {
              rules.push({ prefix: m[1].trim(), mode: m[2] as ApplyMode });
            }
          }
          this.plugin.settings.folderRules = rules;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Your name in comment replies")
      .addText((t) =>
        t.setValue(this.plugin.settings.userName).onChange(async (v) => {
          this.plugin.settings.userName = v.trim() || "me";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Floating 'Ask collaborator' button")
      .setDesc(
        "Where the button may appear when you select text. In editing mode you can always use right-click → Ask collaborator, or the command."
      )
      .addDropdown((dd) =>
        dd
          .addOption("reading", "Reading view only (recommended)")
          .addOption("always", "Reading and editing views")
          .addOption("off", "Never")
          .setValue(this.plugin.settings.askButtonMode)
          .onChange(async (v) => {
            this.plugin.settings.askButtonMode = v as "off" | "reading" | "always";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Audit log")
      .setDesc("Append every applied external edit to a log note.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.auditLog).onChange(async (v) => {
          this.plugin.settings.auditLog = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Audit log note")
      .addText((t) =>
        t
          .setPlaceholder("Co-edit log.md")
          .setValue(this.plugin.settings.auditLogPath)
          .onChange(async (v) => {
            this.plugin.settings.auditLogPath = v.trim() || "Co-edit log.md";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show restore points in the panel")
      .setDesc(
        "Snapshots are always taken before external edits; this only controls whether they appear in the co-edit panel. They stay available via the 'Restore snapshot' command."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showRestorePoints).onChange(async (v) => {
          this.plugin.settings.showRestorePoints = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Largest file to merge (KB)")
      .setDesc(
        "Files bigger than this are left to Obsidian's default handling. Raise it if you co-edit very long manuscripts."
      )
      .addSlider((s) =>
        s
          .setLimits(500, 20000, 500)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.maxFileKB)
          .onChange(async (v) => {
            this.plugin.settings.maxFileKB = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Start each session with a clear chat")
      .setDesc(
        "On launch, last session's messages move to the chat archive note and the panel starts empty. The History button opens the archive."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.clearChatOnStartup).onChange(async (v) => {
          this.plugin.settings.clearChatOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show proposed changes in the note")
      .setDesc(
        "Pending proposals render as track changes inside the note: struck deletions and green insertions with accept and reject buttons. Off: proposals only appear in the panel and review dialog."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.inlineProposals).onChange(async (v) => {
          this.plugin.settings.inlineProposals = v;
          await this.plugin.saveSettings();
          const f = this.plugin.app.workspace.getActiveFile();
          if (f) this.plugin.refreshInlineProposals(f.path);
        })
      );

    new Setting(containerEl)
      .setName("Remember highlights after closing Obsidian")
      .setDesc(
        "Off: collaborator highlights reset when you close Obsidian. On: they come back where they were."
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.rememberHighlights)
          .onChange(async (v) => {
            this.plugin.settings.rememberHighlights = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Snapshots per file")
      .setDesc("How many pre-edit snapshots to keep for each file.")
      .addSlider((s) =>
        s
          .setLimits(1, 50, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.snapshotLimit)
          .onChange(async (v) => {
            this.plugin.settings.snapshotLimit = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Collaborators")
      .setDesc(
        this.plugin.settings.collaborators.length === 0
          ? "None seen yet. Collaborators identify themselves via .obsidian/live-coedit-collaborator.json and get a color automatically. You can also add one here in advance."
          : this.plugin.settings.collaborators
              .map((c) => `${c.name} (color ${c.slot})`)
              .join(", ")
      )
      .addText((t) => {
        t.setPlaceholder("Add a name, press Enter");
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.plugin.addCollaborator(t.getValue());
            t.setValue("");
            this.display();
          }
        });
      });
  }
}
