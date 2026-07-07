#!/usr/bin/env python3
"""Protocol tests for the bundled bridges: parsing, targeting etiquette, and
race-safe verified writes against a throwaway vault."""

import importlib.util
import os
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

count = 0


def t(name, ok):
    global count
    count += 1
    if not ok:
        print("FAIL", name)
        sys.exit(1)


def load(name):
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), os.path.join(ROOT, "integrations", f"{name}.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_vault():
    vault = tempfile.mkdtemp()
    os.mkdir(os.path.join(vault, ".obsidian"))
    open(os.path.join(vault, "Co-edit chat.md"), "w").write("# Co-edit chat\n\n")
    return vault


def suite(mod, label):
    m = mod.CHAT_LINE.match("- **me** (18:44): hello")
    t(f"{label}: chat parse", bool(m) and m.group(1) == "me")
    m = mod.CHAT_LINE.match("- **me → perplexity** (18:44): targeted")
    t(f"{label}: targeted parse", bool(m))
    m = mod.SNIP.match("✂️ Notes/d.md [10-25]: «old» → smoother")
    t(f"{label}: snip offsets", bool(m) and m.group(2) == "10")
    m = mod.SNIP.match("✂️ d.md: «old» → tighten")
    t(f"{label}: snip no offsets", bool(m) and m.group(2) is None)

    vault = make_vault()
    b = mod.Bridge(vault, "fake-key")
    p = os.path.join(vault, "t.md")

    open(p, "w").write("alpha PASSAGE omega\n")
    t(f"{label}: apply basic", b.apply_verified(p, "PASSAGE", "DONE") and "DONE" in open(p).read())

    open(p, "w").write("alpha PASSAGE omega\nuser typing\n")

    def clobber():
        time.sleep(1.0)
        open(p, "w").write("alpha PASSAGE omega\nuser typing\n")

    th = threading.Thread(target=clobber)
    th.start()
    ok = b.apply_verified(p, "PASSAGE", "DONE2")
    th.join()
    final = open(p).read()
    t(f"{label}: survives autosave clobber", ok and "DONE2" in final)
    t(f"{label}: preserves user typing", "user typing" in final)

    open(p, "w").write("nothing to see\n")
    t(
        f"{label}: vanished passage is safe",
        b.apply_verified(p, "PASSAGE", "X") is False and open(p).read() == "nothing to see\n",
    )


for name in ("claude-bridge", "perplexity-bridge"):
    suite(load(name), name)

print(f"bridges: {count} tests passed")
