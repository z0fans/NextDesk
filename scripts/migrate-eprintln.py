#!/usr/bin/env python3
"""
Migrate eprintln! calls in NextDesk's cliprdr module to log:: macros.

Strategy:
1. For each `eprintln!("[cliprdr...] ...")` line, if the IMMEDIATELY following
   non-blank line is `log::info!/debug!/warn!(...)`, delete the `eprintln!`
   (it's redundant — env_logger now writes to stderr too).
2. For each lone `eprintln!`, replace with `log::debug!`.

Run: `python3 scripts/migrate-eprintln.py src-tauri/src/cliprdr/backend.rs`
"""
import re
import sys
from pathlib import Path


def migrate_file(path: Path) -> int:
    text = path.read_text()
    lines = text.splitlines(keepends=True)

    out = []
    i = 0
    changed = 0
    while i < len(lines):
        line = lines[i]
        if re.match(r'\s*eprintln!\(', line):
            # Find end of the macro (matching parens)
            block_start = i
            depth = 0
            for ch in line:
                if ch == '(':
                    depth += 1
                elif ch == ')':
                    depth -= 1
            j = i
            while depth > 0 and j + 1 < len(lines):
                j += 1
                for ch in lines[j]:
                    if ch == '(':
                        depth += 1
                    elif ch == ')':
                        depth -= 1

            block = ''.join(lines[block_start:j + 1])

            # Check if next non-blank line is a log:: macro
            k = j + 1
            while k < len(lines) and lines[k].strip() == '':
                k += 1
            next_is_log = (
                k < len(lines)
                and re.match(r'\s*log::(info|debug|warn|error|trace)!\(', lines[k])
            )

            if next_is_log:
                # Drop the eprintln (paired log:: takes over)
                changed += 1
                i = j + 1
                continue
            else:
                # Convert eprintln! → log::debug!
                new_block = re.sub(
                    r'^(\s*)eprintln!',
                    r'\1log::debug!',
                    block,
                    count=1,
                )
                out.append(new_block)
                changed += 1
                i = j + 1
                continue
        else:
            out.append(line)
            i += 1

    if changed > 0:
        path.write_text(''.join(out))
    return changed


def main():
    if len(sys.argv) < 2:
        print("Usage: migrate-eprintln.py <file.rs> [<file.rs>...]")
        sys.exit(1)
    total = 0
    for arg in sys.argv[1:]:
        p = Path(arg)
        n = migrate_file(p)
        print(f"  {p}: {n} eprintln blocks migrated")
        total += n
    print(f"Total: {total} eprintln blocks migrated")


if __name__ == "__main__":
    main()
