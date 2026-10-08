#!/usr/bin/env python3
"""Extract the ebuild's RozeLynx branding block, by CONTENT rather than by
line number.

Why this file exists at all
---------------------------
The first version of this harness took `sed -n '567,1008p'` of the ebuild. That
looks like it extracts a block and is not one: 567..1008 is a *window* that
happened to start inside the first `if use rozelynx; then` and happen to contain
the branding code further down. The only guard was a grep for that `if`, which
the window satisfied by construction.

It then went stale in the worst possible way. It was pointed at a COPY of the
ebuild in /tmp, so for the rest of that session it kept passing while testing
`46f34b14` while the tree moved to `81d46b38`. A harness that reports success
about the wrong file is worse than no harness, and this is the third time this
plan has been bitten by a positional assumption (G.1.1-G.1.3 were all patch
hunks anchored on line offsets).

So the boundaries here are found by what the code SAYS, not where it sits:

  start  the `rm -rf browser/branding/rozelynx` that creates the branding
         directory the slot writes go into, so the slice is RUNNABLE rather
         than a fragment that dies on the first write;
  end    the last line of the branding work, found by scanning forward from the
         final `rozelynx_install_vector_slot` call to the end of the
         wordmark `cp` pair that closes it.

Every step asserts. If the markers are not found the extractor exits 2 rather
than emitting a slice that might be empty, partial, or the wrong thing - the
behaviour that made the original silently wrong.
"""

import argparse
import pathlib
import re
import sys

# Markers that must be present in whatever gets extracted. Each is a thing the
# harness asserts about afterwards, so its absence means the harness is no
# longer testing what it claims to. Split by WHERE they have to be, because the
# region's own locals precede the helper that defines the contract.
# The region does not START at the helper. It starts where the branding
# directory is created - `rm -rf browser/branding/rozelynx` immediately followed
# by the `cp -a .../unofficial` that seeds it - because the slot writes go into
# that copy and die without it. The first version of this harness got that right
# only by accident: its 567-1008 window happened to span both halves.
BEFORE_HELPER = [
    # Declared above the region and used inside it. Each one added here is a
    # bug this harness had: the slice ran, hit an unset variable, and either
    # died (loud) or wrote an empty path (quiet, and much worse).
    "local rozelynx_svg=",
    "rm -rf browser/branding/rozelynx",
    "local branding_dir=",
]
AFTER_HELPER = [
    "rozelynx_install_vector_slot() {",
    "command -v magick",
    "rozelynx_install_vector_slot about-logo.svg",
    "rozelynx_install_vector_slot extensions-panel-empty.svg",
    "rozelynx_install_vector_slot extensions-panel-empty-onboarding.svg",
    "rozelynx_install_vector_slot cpm-fox-illustration.svg",
    "rozelynx_install_vector_slot plus.svg",
]
REQUIRED = BEFORE_HELPER + AFTER_HELPER

# Markers that identify the START of the region: the last of these seen before
# the helper is defined is the region preamble.
START_ANCHORS = [
    "local branding_src=",
    "local branding_dir=",
]

# The block ends after the wordmark cp pair, which is the last branding write.
END_ANCHORS = [
    "about-wordmark.svg",
    "firefox-wordmark.svg",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ebuild")
    ap.add_argument("out", help="where to write the extracted block")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    src = pathlib.Path(args.ebuild)
    if not src.exists():
        sys.stderr.write("FATAL: no ebuild at %s\n" % src)
        return 2
    lines = src.read_text().splitlines()

    def first(marker, after=0):
        for i in range(after, len(lines)):
            if marker in lines[i]:
                return i
        return -1

    helper = first("rozelynx_install_vector_slot() {")
    if helper < 0:
        sys.stderr.write(
            "FATAL: no rozelynx_install_vector_slot() definition in %s.\n"
            "The branding block has moved or been renamed; this harness needs\n"
            "updating rather than guessing at a range.\n" % src)
        return 2

    # Walk BACK from the helper: every BEFORE marker, plus the comment run and
    # the contiguous START anchors above them, so the extracted slice is a
    # runnable region rather than a fragment.
    start = helper
    for marker in BEFORE_HELPER:
        i = -1
        for j in range(helper - 1, -1, -1):
            if marker in lines[j]:
                i = j
                break
        if i < 0:
            sys.stderr.write("FATAL: %r not found before the helper in %s\n"
                             % (marker, src))
            return 2
        start = min(start, i)
    while start > 0 and any(a in lines[start - 1] for a in START_ANCHORS):
        start -= 1
    while start > 0 and lines[start - 1].lstrip().startswith("#"):
        start -= 1

    # Walk FORWARD from the helper through every marker, then past the closing
    # wordmark cp pair.
    end = helper
    for marker in AFTER_HELPER:
        i = first(marker, after=end)
        if i < 0:
            sys.stderr.write(
                "FATAL: %r not found at or after line %d of %s.\n"
                "The branding block no longer has the shape this harness\n"
                "extracts. Update the markers rather than widening a range.\n"
                % (marker, end + 1, src))
            return 2
        end = max(end, i)
    last_wordmark = first(END_ANCHORS[-1], after=end)
    if last_wordmark < 0:
        sys.stderr.write("FATAL: the closing wordmark cp is missing\n")
        return 2
    end = last_wordmark
    # The cp is a two-line command; take its continuation too.
    while end + 1 < len(lines) and lines[end + 1].strip().endswith("\\"):
        end += 1

    block = lines[start:end + 1]
    text = "\n".join(block) + "\n"

    missing = [m for m in REQUIRED if m not in text]
    if missing:
        sys.stderr.write("FATAL: extracted block is missing %r\n" % missing)
        return 2

    # Every variable the slice READS must also be ASSIGNED in it, or be one the
    # harness's stubs provide. This is the check that turns "the slice died on
    # line 1" into "the slice is missing an assignment for X", and it is the
    # general form of every failure this harness has had: a positional cut that
    # leaves a `local` on the other side of it. Two of the three boundaries
    # above exist only because this check would have named them.
    # `local a=1 b=2` on one line is the Gecko/portage style and is how the
    # vector helper declares five of its six parameters, so a single-name
    # pattern reports them all as unassigned reads.
    assigned = set()
    for line in text.splitlines():
        m = re.match(r"^\s*(?:local\s+|export\s+|declare\s+-\w+\s+)?(.*)$", line)
        if not m:
            continue
        rest = m.group(1)
        if "=" not in rest and "(" in rest:
            continue                      # a call, not a declaration
        for name in re.findall(r"(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=", rest):
            assigned.add(name)
    assigned |= set(re.findall(r"^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b", text, re.M))
    assigned |= set(re.findall(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\)\s*$", text, re.M))
    # A `local` with no value (e.g. `local raster="$src" origin note`) still
    # declares its trailing names.
    for m in re.finditer(r"^\s*(?:local|export)\s+(.*)$", text, re.M):
        tail = m.group(1)
        if "=" in tail:
            tail = tail[tail.rindex("=") + 1:]
        for name in re.findall(r"(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)", tail):
            assigned.add(name)
    stubbed = {
        # Provided by the harness's stub preamble or by bash itself.
        "FILESDIR", "PATH", "HOME", "TMPDIR", "PWD", "IFS", "RANDOM",
        # Positional parameters: the vector helper takes 6 or 7 of them.
        "1", "2", "3", "4", "5", "6", "7",
    }
    # A perl one-liner's single-quoted program is perl, not bash: the
    # logo-size rewrites say `my ($h,$b,$t)=($1,$2,$3); $b =~ s/.../.../`
    # inside the quotes, and none of those names exists in the shell.
    # Blank the quoted programs (none spans a line in this ebuild) before
    # the read scan, so the audit stays about bash; the words around them
    # -- `perl -0pi -e` and the trailing "${ncss}" -- stay in it. Without
    # this the audit demands a bash `local` for perl lexicals and refuses
    # to extract the block at all.
    bash_text = "\n".join(
        re.sub(r"'[^']*'", "''", line) if re.search(r"(?:^|\s)perl\s", line) else line
        for line in text.splitlines())
    read = set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", bash_text))
    read |= set(re.findall(r"\$([A-Za-z_][A-Za-z0-9_]*)", bash_text))
    unassigned = sorted(r for r in read if r not in assigned and r not in stubbed)
    if unassigned:
        sys.stderr.write(
            "FATAL: the extracted block reads variables it never assigns: %s\n"
            "       A `local` the region depends on sits above the extracted\n"
            "       start. Add it to BEFORE_HELPER - do not widen a range.\n"
            % ", ".join(unassigned))
        return 2

    out = pathlib.Path(args.out)
    out.write_text(text)

    if not args.quiet:
        import hashlib
        print("ebuild   : %s" % src)
        print("  sha256 : %s" % hashlib.sha256(src.read_bytes()).hexdigest()[:16])
        print("extracted: lines %d-%d (%d lines) -> %s"
              % (start + 1, end + 1, len(block), out))
        for m in REQUIRED:
            print("  found   : %s" % m)
        print("  assigns : %d variable(s), all reads accounted for"
              % len(assigned))
    return 0


if __name__ == "__main__":
    sys.exit(main())
