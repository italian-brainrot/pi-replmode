#!/usr/bin/env bash
# The suite's scratch directories accumulate in /tmp: an agent dir per vitest file, a cwd per test that
# wants one, a names dir per test of the encoder. A full audit pass leaves several hundred, and they are
# all disposable — the only thing that must survive is the real Python env, which lives in
# ~/.cache/pi-replmode, never in /tmp.
#
# `find … -mmin +30 -delete` is the wrong tool: the predicate filters every path, so a directory touched
# later than the cut inside an older parent is kept and the parent then "is not empty". Walk the tops and
# rm -rf the old ones.
set -u
AGE="${1:-30}"
removed=0
for pattern in /tmp/replmode-agent-* /tmp/replmode-cwd-* /tmp/replmode-names-*; do
  for d in $pattern; do
    [ -d "$d" ] || continue
    if [ -n "$(find "$d" -maxdepth 0 -mmin "+$AGE")" ]; then
      rm -rf "$d" && removed=$((removed + 1))
    fi
  done
done
echo "removed $removed scratch dir(s) older than $AGE min"
