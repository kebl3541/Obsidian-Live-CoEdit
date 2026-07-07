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
  externalMarksField,
  readMarks,
} from "./marks";
import { SnapshotStore, SnapshotInfo } from "./snapshots";
import { CoComment, scanComments } from "./comments";
import { CoEditPanelView, PANEL_VIEW_TYPE } from "./panel";

const MAX_FILE_SIZE = 2_000_000; // bytes; larger files are left to Obsidian

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
}

const DEFAULT_SETTINGS: LiveCoEditSettings = {
  applyMode: "auto",
  folderRules: [],
  auditLog: true,
  auditLogPath: "Co-edit log.md",
  snapshotLimit: 10,
  userName: "me",
  collaborators: [],
};

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
}

export interface MarkListing {
  from: number;
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

  async onload() {
    await this.loadPersisted();

    this.snapshots = new SnapshotStore(
      this.app.vault.adapter,
      `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      this.settings.snapshotLimit
    );

    this.statusEl = this.addStatusBarItem();
    this.setStatus("ready");

    this.registerEditorExtension([externalMarksField, commentHighlighter]);
    this.registerView(PANEL_VIEW_TYPE, (leaf) => new CoEditPanelView(leaf, this));
    this.addRibbonIcon("users", "Open co-edit panel", () => void this.openPanel());

    this.registerEvent(
      this.app.vault.on("modify", (f) => void this.onDiskChange(f))
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (f) => {
        if (f) {
          void this.captureShadow(f);
          this.restoreHighlights(f);
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
      id: "open-panel",
      name: "Open co-edit panel",
      callback: () => void this.openPanel(),
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

    // A co-edit button in every note's own toolbar (top-right of the pane).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.addViewActions())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.addViewActions())
    );

    this.app.workspace.onLayoutReady(() => {
      this.addViewActions();
      const f = this.app.workspace.getActiveFile();
      if (f) {
        void this.captureShadow(f);
        this.restoreHighlights(f);
      }
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
      this.highlights = raw.highlights ?? {};
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
    const data: PersistedData = {
      settings: this.settings,
      highlights: this.highlights,
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
    this.statusEl?.setText(`Co-edit: ${text}`);
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

  private editorView(editor: Editor): EditorView | null {
    return (editor as unknown as { cm?: EditorView }).cm ?? null;
  }

  private async onDiskChange(af: TAbstractFile) {
    if (!(af instanceof TFile) || af.extension !== "md") return;
    if (af.stat.size > MAX_FILE_SIZE) return;

    // Our own guarded writes are not external edits.
    if (this.selfWrites.delete(af.path)) {
      this.shadows.set(af.path, await this.app.vault.cachedRead(af));
      return;
    }

    const mode = this.modeFor(af.path);
    const disk = await this.app.vault.cachedRead(af);
    const editor = this.findEditorFor(af.path);

    if (!editor || mode === "off") {
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

    if (mode === "approve") {
      this.pending.set(af.path, { theirs: disk, base, collaborator: who });
      this.announcePending(af.path, who);
      this.log(`${who} proposed an edit to ${af.path}`);
      return;
    }

    // Automatic mode: snapshot, merge, mark, audit.
    await this.snapshots.save(af.path, buffer);
    const { merged, conflicts } = merge3(base, buffer, disk);
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
    const buffer = editor ? editor.getValue() : pend.base;
    return {
      segments: merge3Segments(pend.base, buffer, pend.theirs).segments,
      buffer,
      collaborator: pend.collaborator,
    };
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
    }
    this.dropPending(path);
    this.log(`you rejected the edit from ${pend?.collaborator ?? "collaborator"} in ${path}`);
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
    this.openReview(path);
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

  async dismissComment(path: string, index: number) {
    const editor = this.findEditorFor(path);
    if (!editor) return;
    const comments = scanComments(editor.getValue());
    const c = comments[index];
    if (!c) return;
    editor.replaceRange("", editor.offsetToPos(c.from), editor.offsetToPos(c.to));
    this.log(`you dismissed a comment from ${c.name} in ${path}`);
  }

  replyToComment(path: string, index: number) {
    const editor = this.findEditorFor(path);
    if (!editor) return;
    const comments = scanComments(editor.getValue());
    const c = comments[index];
    if (!c) return;
    new ReplyModal(this.app, (text) => {
      const insert = ` %%${this.settings.userName}: ${text}%%`;
      editor.replaceRange(insert, editor.offsetToPos(c.to));
      this.log(`you replied to ${c.name} in ${path}`);
      this.refreshPanel();
    }).open();
  }

  // ---- Snapshots ------------------------------------------------------------------

  async snapshotList(path: string): Promise<SnapshotInfo[]> {
    return this.snapshots.list(path);
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

// ---- Review dialog (per-hunk accept/reject + conflict picks) -----------------

class ReviewModal extends Modal {
  private plugin: LiveCoEditPlugin;
  private path: string;
  private choices: boolean[] = [];

  constructor(app: App, plugin: LiveCoEditPlugin, path: string) {
    super(app);
    this.plugin = plugin;
    this.path = path;
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

    const box = contentEl.createDiv({ cls: "live-coedit-diff live-coedit-diff-prose" });
    let p = 0;
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
        continue;
      }

      const idx = p++;
      const wrap = box.createDiv({ cls: "live-coedit-hunk" });
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
        const label = header.createSpan({ text: " Accept" });
        label.addClass("live-coedit-accept-label");
        cb.addEventListener("change", () => (this.choices[idx] = cb.checked));
        this.renderTrackChanges(wrap, seg.mine.join("\n"), seg.theirs.join("\n"));
      }
    }

    const buttons = contentEl.createDiv({ cls: "live-coedit-buttons" });
    const apply = buttons.createEl("button", { text: "Apply accepted changes" });
    apply.addClass("mod-cta");
    apply.addEventListener("click", () => {
      const fresh = this.plugin.getReviewData(this.path);
      if (fresh) {
        const finalText = composeSegments(fresh.segments, this.choices);
        const accepted = this.choices.filter(Boolean).length;
        void this.plugin.applyReviewed(this.path, finalText, accepted, this.choices.length);
      }
      this.close();
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
          ? "None seen yet. Collaborators identify themselves via .obsidian/live-coedit-collaborator.json and get a color automatically."
          : this.plugin.settings.collaborators
              .map((c) => `${c.name} (color ${c.slot})`)
              .join(", ")
      );
  }
}
