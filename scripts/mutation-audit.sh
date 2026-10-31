#!/usr/bin/env bash
# Is a fixed defect actually pinned by a test? Break it deliberately, run the test file that should
# notice, revert. A mutation that changes nothing means the fix has no test behind it — pass 3 found two
# that way (the `evalue` clipping and `flushLoose`'s `lateWrite`), both pinned since.
#
# Add a line here whenever you fix something the audit reported, and run this before declaring a pass
# green. Anchors are exact source text: if one stops matching, the fix moved, so re-find it rather than
# deleting the line.
set -u
cd /home/qq/distrobox/ubuntu/Projects/pi-replmode

run_mutation() {
  local label="$1" file="$2" py="$3" testspec="$4"
  echo "=================================================="
  echo "MUTATION ${label}"
  python3 - "$file" "$py" <<'EOF'
import sys, pathlib
path, src = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
old, new = src.split("\n---MUTATE---\n")
if old not in text:
    print("!! anchor not found:", old[:60]); sys.exit(2)
path.write_text(text.replace(old, new, 1))
EOF
  if [ $? -ne 0 ]; then echo "  (skipped: anchor)"; git checkout -- "$file"; return; fi
  npx vitest --run "$testspec" 2>&1 | grep -E "^\s+[×✓] |Tests  " | tail -10
  git checkout -- "$file"
}

run_mutation "M1 channelFileStem never appends a digest" src/names.ts '  if (readable === name) return readable;
  return `${readable}-${digest(name)}`;
---MUTATE---
  return readable;' "test/names.test.ts"

run_mutation "M2 cap: starting does not occupy a slot" src/manager.ts 'const occupying = new Set([...this.starting.keys(), ...live.map((channel) => channel.name)]);
---MUTATE---
const occupying = new Set([...live.map((channel) => channel.name)]);' "test/cap.test.ts"

run_mutation "M3 traceback gets no share of the limit" src/manager.ts '    const tracebackBudget = Math.min(
      tracebackRaw.length,
      Math.max(Math.floor(MAX_OUTPUT_CHARS * TRACEBACK_SHARE), MAX_OUTPUT_CHARS - Math.min(read.text.length, MAX_OUTPUT_CHARS)),
    );
---MUTATE---
    const tracebackBudget = 0;' "test/honesty.test.ts"

run_mutation "M4 start failure drops the startup output again" src/channel.ts '    if (!last) return;
---MUTATE---
    if (!last) {
      this.loose = [];
      this.looseBytes = 0;
      return;
    }' "test/lifecycle.test.ts"

run_mutation "M5 fatal frame is not kept" src/channel.ts '        this.fatalNote = text;
---MUTATE---
        this.fatalNote = undefined;' "test/lifecycle.test.ts"

run_mutation "M6 flushLoose uses Exec.write again (bytes dropped after the log closed)" src/channel.ts '    last.lateWrite(trailing);
---MUTATE---
    last.write(trailing);' "test/lifecycle.test.ts"

run_mutation "M7 the lost-channel note keyed by file stem again" src/manager.ts '            const channel = typeof parsed.channel === "string" && parsed.channel ? parsed.channel : stem;
---MUTATE---
            const channel = stem;' "test/names.test.ts"

run_mutation "M8 death note stops saying an interrupt was in flight" src/channel.ts 'const interrupt = !exec.settled && exec.killRequested ? ", shortly after an interrupt was requested for this cell" : "";
---MUTATE---
const interrupt = "";' "test/lifecycle.test.ts"

run_mutation "M9 truncateMiddle back to file coordinates for the tail" src/format.ts '  let tailStart = cutAtLineEnd(text, text.length - tailBudget, text.length - Math.floor(tailBudget * 0.4));
---MUTATE---
  let tailStart = cutAtLineEnd(text, totalChars - tailBudget, totalChars - Math.floor(tailBudget * 0.4));' "test/format.test.ts"

run_mutation "M10 evalue not clipped" src/manager.ts '    const evalue = frame?.evalue ? oneLine(frame.evalue, EVALUE_CHARS) : null;
---MUTATE---
    const evalue = frame?.evalue ?? null;' "test/honesty.test.ts"

run_mutation "M11 failure() invents status error" src/index.ts '  const status: TaskStatus = error instanceof ChannelBusyError ? "running" : "dead";
---MUTATE---
  const status: TaskStatus = "running";' "test/honesty.test.ts"

run_mutation "M12 RUN_OUTPUT keeps output/truncated required" src/index.ts '    output: Type.Optional(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
---MUTATE---
    output: Type.String(),
    truncated: Type.Boolean(),' "test/honesty.test.ts"

echo "=================================================="
git status --short
