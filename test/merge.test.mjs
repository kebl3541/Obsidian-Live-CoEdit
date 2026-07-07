// Merge engine test suite. Run via `npm test` (builds merge.ts first).
import { strict as assert } from "node:assert";
import { merge3, merge3Segments, composeSegments, charMerge3, diffWords } from "./merge.build.mjs";

let count = 0;
function t(name, fn) {
  count++;
  try {
    fn();
  } catch (e) {
    console.error("FAIL", name);
    throw e;
  }
}

const m = (b, mi, th) => {
  const r = merge3(b, mi, th);
  return [r.merged, r.conflicts];
};

t("disjoint edits merge", () =>
  assert.deepEqual(
    m("alpha\nbeta\ngamma\ndelta", "ALPHA\nbeta\ngamma\ndelta", "alpha\nbeta\ngamma\nDELTA"),
    ["ALPHA\nbeta\ngamma\nDELTA", 0]
  ));

t("append plus edit", () =>
  assert.deepEqual(m("one\ntwo", "ONE\ntwo", "one\ntwo\nthree"), ["ONE\ntwo\nthree", 0]));

t("conflict keeps the user's text", () =>
  assert.deepEqual(m("hello world", "hello USER", "hello CLAUDE"), ["hello USER", 1]));

t("delete plus edit", () =>
  assert.deepEqual(m("a\nb\nc\nd\ne", "a\nd\ne", "a\nb\nc\nd\nEEE"), ["a\nd\nEEE", 0]));

t("identical change is not a conflict", () =>
  assert.deepEqual(m("x\ny", "x\nY!", "x\nY!"), ["x\nY!", 0]));

t("external only change flows in", () =>
  assert.deepEqual(m("p\nq", "p\nq", "p\nq\nr"), ["p\nq\nr", 0]));

t("insertions at different places both survive", () =>
  assert.deepEqual(
    m("start\nmiddle\nend", "start\nU\nmiddle\nend", "start\nmiddle\nC\nend"),
    ["start\nU\nmiddle\nC\nend", 0]
  ));

t("interleaved multi-hunk", () =>
  assert.deepEqual(
    m("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8", "l1\nX2\nl3\nl4\nl5\nl6\nX7\nl8", "l1\nl2\nl3\nY4\nl5\nY6\nl7\nl8"),
    ["l1\nX2\nl3\nY4\nl5\nY6\nX7\nl8", 0]
  ));

t("character merge rescues same-line edits", () =>
  assert.deepEqual(m("hello world.", "Hello world.", "hello world!"), ["Hello world!", 0]));

t("character merge direct", () =>
  assert.equal(charMerge3("the cat sat", "The cat sat", "the cat sat!"), "The cat sat!"));

t("true character conflict returns null", () =>
  assert.equal(charMerge3("abc", "aXc", "aYc"), null));

t("same-point insertions conflict", () =>
  assert.equal(charMerge3("x", "x-user", "x-claude"), null));

t("segments and partial composition", () => {
  const seg = merge3Segments("a\nb\nc", "a\nb\nc", "a\nB2\nc\nd");
  assert.equal(seg.segments.filter((s) => s.kind === "proposal").length, 2);
  assert.equal(composeSegments(seg.segments), "a\nB2\nc\nd");
  assert.equal(composeSegments(seg.segments, [false, true]), "a\nb\nc\nd");
  assert.equal(composeSegments(seg.segments, [false, false]), "a\nb\nc");
});

t("conflict defaults to mine, opt into theirs", () => {
  const seg = merge3Segments("x", "x-user", "x-claude");
  assert.equal(composeSegments(seg.segments), "x-user");
  assert.equal(composeSegments(seg.segments, [true]), "x-claude");
});

t("word diff reconstructs both sides exactly", () => {
  const a = "One two three four five.";
  const b = "One 2 three insert four five!";
  const toks = diffWords(a, b);
  assert.equal(toks.filter((x) => x.kind !== "del").map((x) => x.text).join(""), b);
  assert.equal(toks.filter((x) => x.kind !== "add").map((x) => x.text).join(""), a);
});

t("large file degrades gracefully", () => {
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
  const r = merge3(big, big + "\nmine", big + "\ntheirs");
  assert.equal(typeof r.merged, "string");
});

console.log(`merge: ${count} tests passed`);
