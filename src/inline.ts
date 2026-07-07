// In-document track changes: renders a pending proposal inside the editor.
// Text the proposal would delete is struck through; text it would insert is
// shown as green ghost widgets at the exact spot, each with accept/reject
// buttons. The buffer itself is untouched until the user decides.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

export interface InlineAdd {
  pos: number;
  text: string;
  proposalIndex: number;
}

export interface InlineDel {
  from: number;
  to: number;
  proposalIndex: number;
}

export interface InlineProposalSpec {
  dels: InlineDel[];
  adds: InlineAdd[];
  onResolve: (proposalIndex: number, accept: boolean) => void;
}

export const setInlineProposals = StateEffect.define<InlineProposalSpec>();
export const clearInlineProposals = StateEffect.define<null>();

class AddWidget extends WidgetType {
  constructor(
    private text: string,
    private proposalIndex: number,
    private onResolve: (i: number, accept: boolean) => void
  ) {
    super();
  }

  eq(other: AddWidget): boolean {
    return other.text === this.text && other.proposalIndex === this.proposalIndex;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "live-coedit-ghost";
    if (this.text.length > 0) {
      const txt = document.createElement("span");
      txt.className = "live-coedit-ghost-text";
      txt.textContent = this.text;
      span.appendChild(txt);
    }

    const mk = (label: string, cls: string, accept: boolean) => {
      const b = document.createElement("button");
      b.className = `live-coedit-ghost-btn ${cls}`;
      b.textContent = label;
      b.title = accept ? "Accept this change" : "Reject this change";
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onResolve(this.proposalIndex, accept);
      });
      span.appendChild(b);
    };
    mk("✓", "live-coedit-ghost-yes", true);
    mk("✕", "live-coedit-ghost-no", false);
    return span;
  }

  ignoreEvent(): boolean {
    return true; // let our own listeners handle clicks
  }
}

const delMark = (proposalIndex: number) =>
  Decoration.mark({
    class: "live-coedit-prop-del",
    attributes: { title: "Proposed deletion" },
    proposalIndex,
  } as Parameters<typeof Decoration.mark>[0]);

export const inlineProposalsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setInlineProposals)) {
        const spec = e.value;
        const ranges = [];
        for (const d of spec.dels) {
          if (d.to > d.from) ranges.push(delMark(d.proposalIndex).range(d.from, d.to));
        }
        for (const a of spec.adds) {
          ranges.push(
            Decoration.widget({
              widget: new AddWidget(a.text, a.proposalIndex, spec.onResolve),
              side: 1,
            }).range(a.pos)
          );
        }
        ranges.sort((x, y) => x.from - y.from || x.to - y.to);
        deco = Decoration.set(ranges, true);
      } else if (e.is(clearInlineProposals)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
