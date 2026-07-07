import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type LiveCoEditPlugin from "./main";

export const PANEL_VIEW_TYPE = "live-coedit-panel";

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return (i >= 0 ? path.slice(i + 1) : path).replace(/\.md$/, "");
}

// Sidebar panel: pending proposals, collaborator changes in the active file,
// comments, snapshots, and recent activity.
export class CoEditPanelView extends ItemView {
  private plugin: LiveCoEditPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: LiveCoEditPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Co-edit";
  }

  getIcon(): string {
    return "users";
  }

  onOpen(): Promise<void> {
    void this.refresh();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => void this.refresh())
    );
    return Promise.resolve();
  }

  private iconBtn(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLElement {
    const b = parent.createEl("button", {
      cls: "live-coedit-iconbtn clickable-icon",
      attr: { "aria-label": label },
    });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
    return b;
  }

  // Guards against overlapping refreshes double-painting the panel: all data
  // is gathered first, then the DOM is rebuilt in one synchronous pass, and
  // stale refreshes abandon before painting.
  private refreshGen = 0;

  async refresh(): Promise<void> {
    const gen = ++this.refreshGen;
    const file = this.app.workspace.getActiveFile();

    // Gather everything up front (async), before touching the DOM.
    const pendingPaths = this.plugin.pendingPaths();
    const marks = file ? this.plugin.marksInFile(file.path) : [];
    const comments = file ? this.plugin.commentsInFile(file.path) : [];
    const snaps =
      file && this.plugin.settings.showRestorePoints
        ? await this.plugin.snapshotList(file.path)
        : [];
    const msgs = await this.plugin.chatMessages();
    if (gen !== this.refreshGen) return; // a newer refresh superseded this one

    const el = this.contentEl;
    el.empty();
    el.addClass("live-coedit-panel");

    // Header with the active file's name and a refresh button.
    const header = el.createDiv({ cls: "live-coedit-header" });
    header.createEl("strong", {
      text: file ? basename(file.path) : "No file open",
    });
    this.iconBtn(header, "refresh-cw", "Refresh", () => void this.refresh());

    // Chat lives at the top: it is the steering wheel of the collaboration.
    this.renderChat(el, msgs);

    // Friendly empty state when nothing else is happening.
    if (
      pendingPaths.length === 0 &&
      marks.length === 0 &&
      comments.length === 0 &&
      snaps.length === 0
    ) {
      const empty = el.createDiv({ cls: "live-coedit-welcome" });
      empty.createEl("p", {
        cls: "live-coedit-hint",
        text: "When your collaborator edits an open note, proposals to review, their highlighted changes, and comments show up here.",
      });
      return;
    }

    // --- Needs your review (most important, always on top) --------------------
    if (pendingPaths.length > 0) {
      const s = this.section(el, "bell", "Needs your review", pendingPaths.length);
      for (const path of pendingPaths) {
        const row = s.createDiv({ cls: "live-coedit-row live-coedit-pending" });
        row.createSpan({
          cls: "live-coedit-file",
          text: basename(path),
          attr: { title: path },
        });
        const review = row.createEl("button", { text: "Review" });
        review.addClass("mod-cta");
        review.addEventListener("click", () => this.plugin.openReview(path));
        const accept = row.createEl("button", {
          text: "Accept all",
          cls: "live-coedit-smallbtn",
        });
        accept.addEventListener("click", () => {
          void this.plugin.acceptAllPending(path).then(() => this.refresh());
        });
        const reject = row.createEl("button", {
          text: "Reject",
          cls: "live-coedit-smallbtn mod-warning",
        });
        reject.addEventListener("click", () => {
          void this.plugin.rejectPending(path).then(() => this.refresh());
        });
      }
    }

    // --- Collaborator changes in the active file ------------------------------
    if (marks.length > 0 && file) {
      const s = this.section(el, "highlighter", "Their changes here", marks.length);
      for (const m of marks) {
        const row = s.createDiv({
          cls: "live-coedit-row live-coedit-clickable",
          attr: { title: "Click to jump there" },
        });
        row.createSpan({
          cls: `live-coedit-chip live-coedit-slot${m.slot}`,
          text: m.name,
        });
        row.createSpan({ cls: "live-coedit-lineno", text: `L${m.line + 1}` });
        row.createSpan({ cls: "live-coedit-excerpt", text: m.excerpt });
        row.addEventListener("click", () => void this.plugin.jumpTo(file.path, m.from));
      }
      const clear = s.createEl("button", {
        text: "Mark all as seen",
        cls: "live-coedit-smallbtn",
      });
      clear.addEventListener("click", () => {
        this.plugin.clearHighlightsFor(file.path);
        void this.refresh();
      });
    }

    // --- Comments --------------------------------------------------------------
    if (comments.length > 0 && file) {
      const s = this.section(el, "message-circle", "Comments", comments.length);
      comments.forEach((c, idx) => {
        const row = s.createDiv({ cls: "live-coedit-comment-row" });
        const top = row.createDiv({ cls: "live-coedit-clickable" });
        top.createSpan({ cls: "live-coedit-chip", text: c.name });
        top.createSpan({ cls: "live-coedit-lineno", text: ` L${c.line + 1}` });
        top.addEventListener("click", () => void this.plugin.jumpTo(file.path, c.from));
        row.createDiv({ cls: "live-coedit-comment-text", text: c.text });
        const actions = row.createDiv({ cls: "live-coedit-actions" });
        this.iconBtn(actions, "reply", "Reply", () =>
          this.plugin.replyToComment(file.path, idx)
        );
        this.iconBtn(actions, "check", "Dismiss (remove from note)", () => {
          void this.plugin.dismissComment(file.path, idx).then(() => this.refresh());
        });
      });
    }

    // --- Snapshots ---------------------------------------------------------------
    if (snaps.length > 0 && file) {
      const s = this.section(el, "history", "Restore points", snaps.length);
      for (const snap of snaps.slice(0, 5)) {
        const row = s.createDiv({ cls: "live-coedit-row" });
        row.createSpan({ text: relTime(snap.ts), attr: { title: new Date(snap.ts).toLocaleString() } });
        const btn = row.createEl("button", {
          text: "Restore",
          cls: "live-coedit-smallbtn",
        });
        btn.addEventListener("click", () => {
          void this.plugin.restoreSnapshot(file.path, snap).then(() => this.refresh());
        });
      }
    }

    // --- Recent activity ------------------------------------------------------------
    const recent = this.plugin.recentActivity();
    if (recent.length > 0) {
      const s = this.section(el, "activity", "Activity", recent.length);
      for (const entry of recent.slice(0, 8)) {
        s.createDiv({ cls: "live-coedit-activity", text: entry });
      }
    }
  }

  // Chat with the collaborator, backed by the chat note.
  private renderChat(
    parent: HTMLElement,
    msgs: Awaited<ReturnType<LiveCoEditPlugin["chatMessages"]>>
  ) {
    const s = this.section(
      parent,
      "message-square",
      "Chat",
      msgs.length,
      (head) => {
        const clear = head.createEl("button", {
          text: "Clear",
          cls: "live-coedit-headbtn",
          attr: { "aria-label": "Clear chat history" },
        });
        clear.addEventListener("click", (e) => {
          e.stopPropagation(); // don't toggle the section fold
          void this.plugin.clearChat();
        });
      }
    );

    const log = s.createDiv({ cls: "live-coedit-chatlog" });
    for (const m of msgs) {
      const row = log.createDiv({ cls: "live-coedit-chatmsg" });
      row.createSpan({ cls: "live-coedit-chip", text: m.name });
      row.createSpan({ cls: "live-coedit-lineno", text: ` ${m.time}` });
      row.createDiv({ cls: "live-coedit-chattext", text: m.text });
    }
    log.scrollTop = log.scrollHeight;

    const composer = s.createDiv({ cls: "live-coedit-composer" });
    const input = composer.createEl("input", {
      type: "text",
      placeholder: "Message your collaborator…",
    });
    input.value = this.plugin.chatDraft;
    input.addEventListener("input", () => {
      this.plugin.chatDraft = input.value;
    });
    const send = () => {
      void this.plugin.sendChat(input.value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
    const btn = composer.createEl("button", { text: "Send" });
    btn.addClass("mod-cta");
    btn.addEventListener("click", send);
    // Scroll the chat into view and focus for fast back-and-forth.
    window.setTimeout(() => log.scrollTo({ top: log.scrollHeight }), 0);
  }

  // Collapsible section: click the header to fold/unfold; the collapsed set
  // persists across restarts.
  private section(
    parent: HTMLElement,
    icon: string,
    title: string,
    count: number,
    decorateHead?: (head: HTMLElement) => void
  ): HTMLElement {
    const settings = this.plugin.settings;
    const collapsed = settings.collapsedSections.includes(title);

    const box = parent.createDiv({ cls: "live-coedit-section" });
    const head = box.createDiv({
      cls: "live-coedit-section-head live-coedit-clickable",
    });
    const chevron = head.createSpan({ cls: "live-coedit-section-icon" });
    setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
    const ic = head.createSpan({ cls: "live-coedit-section-icon" });
    setIcon(ic, icon);
    head.createSpan({ text: title });
    head.createSpan({ cls: "live-coedit-count", text: String(count) });
    decorateHead?.(head);

    const body = box.createDiv({ cls: "live-coedit-section-body" });
    if (collapsed) body.hide();

    head.addEventListener("click", () => {
      const nowCollapsed = !settings.collapsedSections.includes(title);
      if (nowCollapsed) {
        settings.collapsedSections.push(title);
        body.hide();
        setIcon(chevron, "chevron-right");
      } else {
        settings.collapsedSections = settings.collapsedSections.filter(
          (t) => t !== title
        );
        body.show();
        setIcon(chevron, "chevron-down");
      }
      void this.plugin.saveSettings();
    });

    return body;
  }
}
