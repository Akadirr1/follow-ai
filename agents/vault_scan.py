#!/usr/bin/env python3
"""Vault wikilink integrity scanner (Layer 0, no model).

Usage:  python agents/vault_scan.py [vault_path]
Reports [[wikilinks]] whose target note does not exist. Without an argument it
looks for a directory containing `.obsidian` under the project root.

This lives in a file on purpose: pasting the same scanner through a shell
heredoc mangled the regex escapes and produced 34 false positives on
2026-08-18. A file's bytes survive transport; a paste does not. Handles
NFC/NFD, table-cell \\| escapes, and Windows path separators.

Windows note: OneDrive renames characters illegal in Windows filenames
(e.g. ":" becomes "&#x3a;"). Such notes exist but no longer match their
wikilink text; they are reported separately as MANGLED, not as broken links.
"""
import html
import os
import re
import sys
import unicodedata


def find_vault(root: str) -> str:
    for dp, dns, _ in os.walk(root):
        dns[:] = [d for d in dns if d not in (".git", "node_modules", "build",
                                              "install", "log")]
        if ".obsidian" in dns:
            return dp
    sys.exit("no vault found (no .obsidian directory) — pass the path: "
             "python agents/vault_scan.py <vault_path>")


VAULT = (sys.argv[1] if len(sys.argv) > 1 else
         find_vault(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "..")))

LINK = re.compile(r"\[\[([^\]\[#]+?)(?:\\?\|[^\]\[]*)?\]\]")


def norm(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def main() -> int:
    if os.name == "nt":
        sys.stdout.reconfigure(encoding="utf-8")

    notes, mangled = set(), {}
    for dp, dns, fns in os.walk(VAULT):
        dns[:] = [d for d in dns if not d.startswith(".")]
        for f in fns:
            if not f.endswith(".md"):
                continue
            stem = norm(f[:-3])
            notes.add(stem)
            # A OneDrive-mangled name ("&#x3a;" etc.) also satisfies links
            # written against the original name — record the mapping.
            unescaped = html.unescape(stem)
            if unescaped != stem:
                mangled[unescaped] = stem
                notes.add(unescaped)

    bad = 0
    for dp, dns, fns in os.walk(VAULT):
        dns[:] = [d for d in dns if not d.startswith(".")]
        for f in fns:
            if not f.endswith(".md"):
                continue
            path = os.path.join(dp, f)
            txt = norm(open(path, encoding="utf-8").read())
            for m in LINK.finditer(txt):
                t = m.group(1).strip().rstrip("\\").strip()
                if t not in notes:
                    print(f"KIRIK: {t}  <- {f}")
                    bad += 1

    for orig, disk in mangled.items():
        print(f"MANGLED filename (OneDrive/Windows): '{disk}' should be '{orig}'")

    print("temiz" if not bad else f"{bad} kirik link")
    return 0


if __name__ == "__main__":
    sys.exit(main())
