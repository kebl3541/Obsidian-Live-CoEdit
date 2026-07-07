// Line-based three-way merge, free of Obsidian imports so it can be tested
// standalone. `base` is the last content both sides agreed on, `mine` is the
// editor buffer (the user's typing), `theirs` is what's now on disk (the
// external collaborator's edit).
//
// Non-overlapping changes merge cleanly. Where both sides changed the same
// lines, the user's version wins and the hunk is counted as a conflict.

export interface MergeResult {
  merged: string;
  conflicts: number;
}

// A hunk replaces base lines [baseStart, baseEnd) with `lines`.
export interface Hunk {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

// LCS-based line diff producing replace-hunks against `base`.
export function diffLines(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        base[i] === other[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let start = -1;
  let acc: string[] = [];
  const flush = (endBase: number) => {
    if (start >= 0) {
      hunks.push({ baseStart: start, baseEnd: endBase, lines: acc });
      start = -1;
      acc = [];
    }
  };

  while (i < n && j < m) {
    if (base[i] === other[j]) {
      flush(i);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      if (start < 0) start = i;
      i++; // line deleted from base
    } else {
      if (start < 0) start = i;
      acc.push(other[j]);
      j++; // line inserted from other
    }
  }
  if (i < n || j < m) {
    if (start < 0) start = i;
    while (j < m) {
      acc.push(other[j]);
      j++;
    }
    hunks.push({ baseStart: start, baseEnd: n, lines: acc });
  } else {
    flush(i);
  }
  return hunks;
}

function overlaps(h: Hunk, s: number, e: number): boolean {
  return h.baseStart < e && h.baseEnd > s;
}

// Replay a group of disjoint, sorted hunks over base region [s, e).
function replay(base: string[], hunks: Hunk[], s: number, e: number): string[] {
  const out: string[] = [];
  let p = s;
  for (const h of hunks) {
    for (let k = p; k < h.baseStart; k++) out.push(base[k]);
    out.push(...h.lines);
    p = h.baseEnd;
  }
  for (let k = p; k < e; k++) out.push(base[k]);
  return out;
}

export function merge3(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { merged: mine, conflicts: 0 };
  if (mine === base) return { merged: theirs, conflicts: 0 };
  if (theirs === base) return { merged: mine, conflicts: 0 };

  const b = base.split("\n");
  const mLines = mine.split("\n");
  const tLines = theirs.split("\n");

  // Guard against pathological sizes (LCS is O(n*m)).
  const tooBig =
    (b.length + 1) * (mLines.length + 1) > 25_000_000 ||
    (b.length + 1) * (tLines.length + 1) > 25_000_000;
  if (tooBig) return { merged: mine, conflicts: 1 };

  const A = diffLines(b, mLines); // user's hunks
  const B = diffLines(b, tLines); // external hunks

  const out: string[] = [];
  let pos = 0;
  let ai = 0;
  let bi = 0;
  let conflicts = 0;

  while (ai < A.length || bi < B.length) {
    const nextA = A[ai];
    const nextB = B[bi];
    const first =
      nextA && (!nextB || nextA.baseStart <= nextB.baseStart) ? nextA : nextB;

    // Grow an overlap group around the first hunk.
    let s = first.baseStart;
    let e = first.baseEnd;
    const ga: Hunk[] = [];
    const gb: Hunk[] = [];
    if (first === nextA) {
      ga.push(A[ai++]);
    } else {
      gb.push(B[bi++]);
    }
    let grew = true;
    while (grew) {
      grew = false;
      while (ai < A.length && overlaps(A[ai], s, e)) {
        const h = A[ai++];
        ga.push(h);
        s = Math.min(s, h.baseStart);
        e = Math.max(e, h.baseEnd);
        grew = true;
      }
      while (bi < B.length && overlaps(B[bi], s, e)) {
        const h = B[bi++];
        gb.push(h);
        s = Math.min(s, h.baseStart);
        e = Math.max(e, h.baseEnd);
        grew = true;
      }
    }

    // Untouched region before the group.
    for (let k = pos; k < s; k++) out.push(b[k]);

    if (gb.length === 0) {
      out.push(...replay(b, ga, s, e));
    } else if (ga.length === 0) {
      out.push(...replay(b, gb, s, e));
    } else {
      const mineText = replay(b, ga, s, e).join("\n");
      const theirsText = replay(b, gb, s, e).join("\n");
      if (mineText === theirsText) {
        out.push(...replay(b, ga, s, e));
      } else {
        // Both sides changed the same region: the user's version wins.
        conflicts++;
        out.push(...replay(b, ga, s, e));
      }
    }
    pos = Math.max(pos, e);
  }
  for (let k = pos; k < b.length; k++) out.push(b[k]);

  return { merged: out.join("\n"), conflicts };
}
