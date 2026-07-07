import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { diffWords } from "./merge";
import type { Segment } from "./merge";
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

  async refresh(force = false): Promise<void> {
    // Never rebuild the panel out from under the user's chat draft, unless
    // the user themself triggered the rebuild (e.g. by sending a message).
    const active = this.contentEl.ownerDocument.activeElement;
    const typing =
      active &&
      this.contentEl.contains(active) &&
      active.matches("textarea, input, select");
    if (typing && !force) return;
    const restoreFocus = Boolean(typing);
    const refocusComposer = () => {
      if (!restoreFocus) return;
      window.setTimeout(() => {
        this.contentEl
          .querySelector<HTMLTextAreaElement>(".live-coedit-composer textarea")
          ?.focus();
      }, 0);
    };

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
    // When nothing else is happening the panel is simply quiet below it.
    this.renderChat(el, msgs);
    if (
      pendingPaths.length === 0 &&
      marks.length === 0 &&
      comments.length === 0 &&
      snaps.length === 0
    ) {
      refocusComposer();
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
        const summary = this.plugin.pendingSummary(path);
        if (summary) {
          row.createSpan({ cls: "live-coedit-excerpt", text: summary });
        }
        this.renderPendingPreview(row, path);
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
        const seen = this.iconBtn(row, "check", "Mark this one as seen", () => {
          this.plugin.dismissMark(file.path, m.from, m.to);
        });
        seen.addEventListener("click", (e) => e.stopPropagation());
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
      comments.forEach((c) => {
        const anchor = { from: c.from, text: c.text };
        const row = s.createDiv({ cls: "live-coedit-comment-row" });
        const top = row.createDiv({ cls: "live-coedit-clickable" });
        top.createSpan({ cls: "live-coedit-chip", text: c.name });
        top.createSpan({ cls: "live-coedit-lineno", text: ` L${c.line + 1}` });
        top.addEventListener("click", () => void this.plugin.jumpTo(file.path, c.from));
        row.createDiv({ cls: "live-coedit-comment-text", text: c.text });
        const actions = row.createDiv({ cls: "live-coedit-actions" });
        this.iconBtn(actions, "reply", "Reply", () =>
          this.plugin.replyToComment(file.path, anchor)
        );
        this.iconBtn(actions, "check", "Dismiss (remove from note)", () => {
          void this.plugin.dismissComment(file.path, anchor).then(() => this.refresh());
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
    refocusComposer();
  }

  // Inline preview of what a pending proposal would change, rendered as
  // word-level track changes right in the panel, so accepting is never blind.
  private renderPendingPreview(parent: HTMLElement, path: string) {
    const data = this.plugin.getReviewData(path);
    if (!data) return;
    const proposals = data.segments.filter(
      (s): s is Extract<Segment, { kind: "proposal" }> => s.kind === "proposal"
    );

    const MAX_SHOWN = 3;
    const box = parent.createDiv({ cls: "live-coedit-preview" });
    for (const p of proposals.slice(0, MAX_SHOWN)) {
      const para = box.createDiv({ cls: "live-coedit-preview-hunk" });
      if (p.conflict) {
        para.createSpan({
          cls: "live-coedit-conflict-tag",
          text: "conflict · ",
        });
      }
      const tokens = diffWords(p.mine.join("\n"), p.theirs.join("\n"));
      for (const tok of tokens) {
        if (tok.kind === "same") {
          // Collapse long unchanged runs so the changed words stand out.
          const words = tok.text.split(/(\s+)/);
          if (words.filter((w) => w.trim()).length > 10) {
            const head = words.slice(0, 6).join("");
            const tail = words.slice(-6).join("");
            para.createSpan({ text: head });
            para.createSpan({ cls: "live-coedit-skip-inline", text: " … " });
            para.createSpan({ text: tail });
          } else {
            para.createSpan({ text: tok.text });
          }
        } else if (tok.kind === "del") {
          para.createSpan({ cls: "live-coedit-w-del", text: tok.text });
        } else {
          para.createSpan({ cls: "live-coedit-w-add", text: tok.text });
        }
      }
    }
    if (proposals.length > MAX_SHOWN) {
      box.createDiv({
        cls: "live-coedit-skip-inline",
        text: `… and ${proposals.length - MAX_SHOWN} more, open Review to see all`,
      });
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
        // Collaborator switcher: only meaningful once there is more than one
        // collaborator to choose between. With a single collaborator the chat
        // simply talks to them, no dropdown.
        const collabs = this.plugin.settings.collaborators;
        if (collabs.length > 1) {
          const select = head.createEl("select", {
            cls: "dropdown live-coedit-target",
            attr: { "aria-label": "Who are you talking to?" },
          });
          const options = ["everyone", ...collabs.map((c) => c.name)];
          for (const name of options) {
            const opt = select.createEl("option", {
              text: name === "everyone" ? "to: all" : `to: ${name}`,
            });
            opt.value = name;
          }
          select.value = this.plugin.settings.activeCollaborator;
          select.addEventListener("pointerdown", (e) => e.stopPropagation());
          select.addEventListener("click", (e) => e.stopPropagation());
          select.addEventListener("change", () => {
            void this.plugin.setActiveCollaborator(select.value);
          });
        }

        const open = head.createEl("button", {
          text: "History",
          cls: "live-coedit-headbtn",
          attr: { "aria-label": "Open the full chat note" },
        });
        open.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.app.workspace.openLinkText(
            this.plugin.settings.chatPath,
            "",
            true
          );
        });
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

    // No empty box when there is nothing to show.
    // No empty box when there is nothing to show.
    const log =
      msgs.length > 0 ? s.createDiv({ cls: "live-coedit-chatlog" }) : null;
    if (log) {
      for (const m of msgs) {
        const row = log.createDiv({ cls: "live-coedit-chatmsg" });
        row.createSpan({
          cls: "live-coedit-chip",
          text: m.target ? `${m.name} → ${m.target}` : m.name,
        });
        row.createSpan({ cls: "live-coedit-lineno", text: ` ${m.time}` });
        row.createDiv({ cls: "live-coedit-chattext", text: m.text });
      }
      log.scrollTop = log.scrollHeight;
    }

    // Liveness: show when the collaborator reports it is actively working.
    const status = this.plugin.collabStatus;
    if (
      status &&
      status.state === "working" &&
      Date.now() - status.ts < 180_000
    ) {
      const busy = s.createDiv({ cls: "live-coedit-working" });
      busy.createSpan({ cls: "live-coedit-working-dot" });
      busy.createSpan({ text: ` ${status.name} is working…` });
    }

    const composer = s.createDiv({ cls: "live-coedit-composer" });
    const input = composer.createEl("textarea", {
      placeholder: "Message your AI collaborator… (Enter sends, Shift+Enter = new line)",
    });
    input.rows = 2;
    input.value = this.plugin.chatDraft;
    input.addEventListener("input", () => {
      this.plugin.chatDraft = input.value;
    });
    const send = () => {
      void this.plugin.sendChat(input.value).then(() => {
        input.value = "";
        void this.refresh(true);
      });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    const btn = composer.createEl("button", { text: "Send" });
    btn.addClass("mod-cta");
    btn.addEventListener("click", send);
    // Scroll the chat into view for fast back-and-forth.
    if (log) {
      window.setTimeout(() => log.scrollTo({ top: log.scrollHeight }), 0);
    }
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
