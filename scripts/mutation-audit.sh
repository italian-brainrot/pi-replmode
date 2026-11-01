#!/usr/bin/env bash
# Is a fixed defect actually pinned by a test? Break it deliberately, run the test file that should
# notice, revert. A mutation that changes nothing means the fix has no test behind it — pass 3 found two
# that way (the `evalue` clipping and `flushLoose`'s `lateWrite`), both pinned since.
#
# Add a line here whenever you fix something the audit reported, and run this before declaring a pass
# green. Anchors are exact source text: if one stops matching, the fix moved, so re-find it rather than
# deleting the line.
#
# Usage: bash scripts/mutation-audit.sh [label-substring]   (a filter, because a full pass is minutes)
set -u
cd /home/qq/distrobox/ubuntu/Projects/pi-replmode

FILTER="${1:-}"
WORK=$(mktemp -d)
MUTATED=""
SURVIVED=()
NOTICED=0
TOTAL=0
cleanup() { [ -n "$MUTATED" ] && git checkout -- $MUTATED; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# Which test names fail in a file, one per line. The count is not enough: while the audit loop is
# running, some tests are red on purpose, so "something failed" says nothing about whether the
# mutation was noticed. A mutation dies when the *set of failing test names* changes.
failing_names() { grep -E "^[[:space:]]+× " "$1" 2>/dev/null | sed "s/^[[:space:]]*× //; s/[[:space:]]*[0-9]*ms[[:space:]]*$//" | sort; }

declare -A BASELINE
baseline() {
  local spec="$1"
  if [ -n "${BASELINE[$spec]+set}" ]; then return; fi
  npx vitest --run "$spec" > "$WORK/base.txt" 2>&1
  BASELINE[$spec]=$(failing_names "$WORK/base.txt")
  echo "  baseline: $(printf '%s\n' "${BASELINE[$spec]}" | grep -c . ) failing test(s) in $spec before any mutation"
}

run_mutation() {
  local label="$1" file="$2" py="$3" testspec="$4"
  if [ -n "$FILTER" ] && [[ "$label" != *"$FILTER"* ]]; then return; fi
  echo "=================================================="
  echo "MUTATION ${label}"
  # The baseline has to be taken while the tree is clean — taking it after the mutation is applied
  # compares the mutated run against itself and reports every mutation as survived.
  baseline "$testspec"
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
  MUTATED="$file"
  # A mutation that does not compile is not a mutation: it proves nothing, and it wastes the run.
  if ! npx tsc --noEmit > "$WORK/tsc.txt" 2>&1; then
    echo "  !! THE MUTATION DOES NOT COMPILE — fix the anchor, this is not a survival:"
    head -5 "$WORK/tsc.txt"
    git checkout -- "$file"; MUTATED=""; return
  fi
  npx vitest --run "$testspec" > "$WORK/run.txt" 2>&1
  local before after
  before=$(printf '%s\n' "${BASELINE[$testspec]}")
  after=$(failing_names "$WORK/run.txt")
  TOTAL=$((TOTAL + 1))
  if [ "$before" = "$after" ]; then
    echo "  SURVIVED — no test noticed; either add one or argue it in docs/AUDIT.md"
    SURVIVED+=("$label")
  else
    NOTICED=$((NOTICED + 1))
    echo "  died — new failing tests:"
    comm -13 <(printf '%s' "$before") <(printf '%s' "$after") | grep -v "^$" | sed 's/^/    × /'
    grep -E "^[[:space:]]+Error|Test Files " "$WORK/run.txt" | head -3 | sed 's/^/    /'
  fi
  git checkout -- "$file"
  MUTATED=""
}

# ── pass 2's fixes, as found by pass 3 ───────────────────────────────────────

run_mutation "M1 channelFileStem never appends a digest" src/names.ts '  if (readable === name && !LOOKS_DIGESTED.test(name)) return readable;
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

run_mutation "M4 start failure drops the startup output again" src/channel.ts '    const parts = [reason ?? this.deathNote, this.fatalNote ? `the daemon said: ${this.fatalNote}` : undefined, this.startupOutput()];
---MUTATE---
    const parts = [reason ?? this.deathNote, this.fatalNote ? `the daemon said: ${this.fatalNote}` : undefined];' "test/lifecycle.test.ts"

run_mutation "M5 fatal frame is not kept" src/channel.ts '        this.fatalNote = text;
---MUTATE---
        this.fatalNote = undefined;' "test/lifecycle.test.ts"

run_mutation "M6 flushLoose uses Exec.write again (bytes dropped after the log closed)" src/channel.ts '    last.lateWrite(trailing, STARTUP_OUTPUT_HEADER);
---MUTATE---
    last.write(trailing);' "test/lifecycle.test.ts"

run_mutation "M7 the lost-channel note keyed by file stem again (pinned by R4-02)" src/manager.ts '            const name = typeof parsed.channel === "string" && parsed.channel ? parsed.channel : "";
---MUTATE---
            const name = typeof parsed.channel === "string" && parsed.channel ? parsed.channel : entry.slice(0, -".jsonl".length);' "test/names.test.ts"

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

# ── pass 3's fixes ───────────────────────────────────────────────────────────

run_mutation "R3-02 the channel name is two argv tokens again" src/channel.ts '        `--channel=${start.name}`,
---MUTATE---
        "--channel", start.name,' "test/names.test.ts"

run_mutation "R3-03 a name that looks digested is used verbatim again" src/names.ts '  if (readable === name && !LOOKS_DIGESTED.test(name)) return readable;
---MUTATE---
  if (readable === name) return readable;' "test/names.test.ts"

run_mutation "R3-04 the refusal blames busy channels when the slots are starting" src/manager.ts '    if (live.length === 0 && starting.length > 0) {
---MUTATE---
    if (false && live.length === 0 && starting.length > 0) {' "test/lifecycle.test.ts"

run_mutation "R3-05 bgStop never reads the death note" src/manager.ts '    const death = exec.deathNote ?? (exec.channel.closed ? exec.channel.deathNote : undefined);
---MUTATE---
    const death: string | undefined = undefined;' "test/resilience.test.ts"

run_mutation "R3-05 bgStop mentions the death but not the variables" src/manager.ts '    if (death) return `\n${death}; the channel is gone and its variables are lost; the next run on it starts a fresh one`;
---MUTATE---
    if (death) return `\n${death}; the channel went`;' "test/resilience.test.ts"

run_mutation "R3-06 the section drops the process-group exception" src/prompt.ts '  "  the process group it kills (a child that left that group survives), and it loses every variable",
  "  in the channel.",
---MUTATE---
  "  its cells started, and it loses every variable in the channel.",' "test/prompt.test.ts"

run_mutation "R3-06 the run guidelines drop it too" src/index.ts '"`bg_stop` interrupts one cell and keeps its channel; `bg_stop {kill: true}` takes the channel down and ends the processes its cells started, except any that moved into a process group of their own.",
---MUTATE---
"`bg_stop` interrupts one cell and keeps its channel; `bg_stop {kill: true}` takes the channel down and ends the processes its cells started.",' "test/prompt.test.ts"

run_mutation "R3-08 two history files, and the last one read wins" src/manager.ts '            if (!known || known.ts <= record.ts) latest.set(record.channel, record);
---MUTATE---
            latest.set(record.channel, record);' "test/names.test.ts"

run_mutation "R3-01 the daemon note ring is bounded by count only" src/channel.ts '    this.daemonNotes.push(oneLine(text, DAEMON_NOTE_CHARS));
---MUTATE---
    this.daemonNotes.push(text);' "test/limits.test.ts"

run_mutation "R3-01 the definitions note quotes every name in full" src/manager.ts 'notes.push(`defined by this cell: ${definitionList(frame.definitions)}`);
---MUTATE---
notes.push(`defined by this cell: ${frame.definitions.join(", ")}`);' "test/limits.test.ts"

run_mutation "R3-01 the prompt section quotes remembered names unbounded" src/prompt.ts '    .map((name) => oneLine(typeof name === "string" ? name : String(name), DEFINITION_HINT_NAME_CHARS))
---MUTATE---
    .map((name) => name)' "test/limits.test.ts"

run_mutation "R3-01 the history file stores the names a cell bound as they came" src/manager.ts 'function definitionNames(names: string[]): string[] {
  return names.slice(0, HISTORY_DEFINITIONS_MAX).map((name) => oneLine(name, HISTORY_NAME_CHARS));
}
---MUTATE---
function definitionNames(names: string[]): string[] {
  return names.slice(0, HISTORY_DEFINITIONS_MAX);
}' "test/limits.test.ts"

run_mutation "R3-09 the truncation note quotes totals taken before the traceback append" src/manager.ts '      const file = countOutput(exec.logPath);
---MUTATE---
      const file = totals ?? { bytes: 0, lines: cut.totalLines, chars: cut.totalChars, partial: false };' "test/limits.test.ts"

run_mutation "R3-10 startup bytes get the late-output header again" src/channel.ts '    last.lateWrite(trailing, STARTUP_OUTPUT_HEADER);
---MUTATE---
    last.lateWrite(trailing);' "test/lifecycle.test.ts"

run_mutation "R3-07 a failed start points at a file it never wrote" src/channel.ts '    const written = this.writeFailedStartOutput();
---MUTATE---
    const written: string | undefined = undefined;' "test/lifecycle.test.ts"

run_mutation "R3-07 the startup buffer drops whole chunks again" src/channel.ts '    const kept = keepNewest(this.loose, LOOSE_MAX_BYTES);
    this.loose = kept.chunks;
    this.looseDropped += kept.dropped;
---MUTATE---
    let total = 0;
    for (const chunk of this.loose) total += chunk.length;
    while (total > LOOSE_MAX_BYTES && this.loose.length > 0) {
      const oldest = this.loose.shift()!;
      total -= oldest.length;
      this.looseDropped += oldest.length;
    }' "test/lifecycle.test.ts"

run_mutation "R3-07 keepNewest keeps the oldest bytes instead of the newest" src/channel.ts '  const dropped = total - cap;
  const kept: Buffer[] = [];
  let skip = dropped;
  for (const chunk of chunks) {
    if (chunk.length <= skip) {
      skip -= chunk.length;
      continue;
    }
    kept.push(skip > 0 ? chunk.subarray(skip) : chunk);
    skip = 0;
  }
---MUTATE---
  const dropped = total - cap;
  const kept: Buffer[] = [];
  let taken = 0;
  for (const chunk of chunks) {
    if (taken >= cap) break;
    kept.push(taken + chunk.length > cap ? chunk.subarray(0, cap - taken) : chunk);
    taken += chunk.length;
  }' "test/buffers.test.ts"

run_mutation "F3-01 the exception name is quoted unclipped in the result" src/manager.ts '    const ename = frame?.ename ? oneLine(frame.ename, ENAME_CHARS) : null;
---MUTATE---
    const ename = frame?.ename ?? null;' "test/limits.test.ts"

run_mutation "F3-01 the exception name is quoted unclipped in the task listing" src/manager.ts '          ename: exec.frame?.ename ? oneLine(exec.frame.ename, ENAME_CHARS) : null,
---MUTATE---
          ename: exec.frame?.ename ?? null,' "test/limits.test.ts"

run_mutation "F3-02 a channel name of any length is accepted" src/manager.ts '    if (channelName.length > MAX_CHANNEL_NAME_CHARS) {
---MUTATE---
    if (false && channelName.length > MAX_CHANNEL_NAME_CHARS) {' "test/names.test.ts"

# ── pass 4's fixes (the fixer's own; each is what a holding test now holds) ───

run_mutation "R4-01 the section quotes a remembered channel name as the file wrote it" src/prompt.ts '  return oneLine(name, HISTORY_CHANNEL_NAME_CHARS);
---MUTATE---
  return name;' "test/limits.test.ts"

run_mutation "R4-01 a channel name with a newline still reshapes the section" src/prompt.ts '  if (UNQUOTABLE.test(name)) return UNQUOTABLE_NAME;
---MUTATE---
  if (false && UNQUOTABLE.test(name)) return UNQUOTABLE_NAME;' "test/limits.test.ts"

run_mutation "R4-01 the restart notification quotes the raw remembered name" src/index.ts '(${notes.map((note) => historyChannelLabel(note)).join(", ")})
---MUTATE---
(${notes.map((note) => note.channel).join(", ")})' "test/limits.test.ts"

run_mutation "R4-03 the never-ready daemon is answered with the bare timeout again" src/channel.ts '        throw await channel.reportNeverReady(`the channel daemon did not report ready within ${readyTimeoutMs / 1000}s`);
---MUTATE---
        throw new Error(`the channel daemon did not report ready within ${readyTimeoutMs / 1000}s`);' "test/lifecycle.test.ts"

run_mutation "R4-04 the settled bg_stop branch ignores that the channel went" src/manager.ts '              this.channelGoneNote(exec) +
---MUTATE---
              "" +' "test/resilience.test.ts"

run_mutation "R4-04 the gone-process probe reads a zombie as still running" src/manager.ts '    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z";
---MUTATE---
    return false;' "test/resilience.test.ts"

run_mutation "R4-06 an aborted call keeps the slot its creation holds" src/manager.ts '    signal?.addEventListener("abort", release, { once: true });
---MUTATE---
    if (false) signal?.addEventListener("abort", release, { once: true });' "test/lifecycle.test.ts"

run_mutation "R4-06 a cancelled call sends its cell anyway once the channel arrives" src/manager.ts '    if (signal?.aborted) {
      return this.abortedResult(
        channel.name,
---MUTATE---
    if (false && signal?.aborted) {
      return this.abortedResult(
        channel.name,' "test/run.test.ts"

run_mutation "R4-06 the abort never reaches the start race" src/channel.ts '      ...(abort ? [abort.promise.then(() => CANCELLED)] : []),
---MUTATE---
      ...(abort ? [] : []),' "test/lifecycle.test.ts"

run_mutation "R4-06 an aborted start leaves its daemon running" src/channel.ts '    void channel.close(START_SHUTDOWN_GRACE_MS);
    throw error;
  } finally {
    timeout.cancel();
---MUTATE---
    if (false) void channel.close(START_SHUTDOWN_GRACE_MS);
    throw error;
  } finally {
    timeout.cancel();' "test/lifecycle.test.ts"

run_mutation "R4-09 the kill answer names no log, and the listing has already forgotten the cell" src/manager.ts ' +
              // The kill is the last thing the model will be told about this cell: closing the channel
              // takes the task out of the listing, so the answer has to carry the log the way a plain
              // stop does (R4-09).
              `\nLog: ${exec.logPath}`
---MUTATE---
' "test/resilience.test.ts"

run_mutation "R4-09 a task removed by its channel closing is blamed on the retention window" src/manager.ts '      this.droppedTasks.set(id, { channel: name, logPath: exec.logPath, why });
---MUTATE---
      this.droppedTasks.set(`dropped-by-a-mutation-${id}`, { channel: name, logPath: exec.logPath, why });' "test/resilience.test.ts"

run_mutation "R4-05 the refusal credits the cap to the env value it ignored" src/manager.ts '      return { value: DEFAULT_MAX_CHANNELS, source: `the default, because PI_REPLMODE_MAX_CHANNELS=${raw} is not a usable cap` };
---MUTATE---
      return { value: DEFAULT_MAX_CHANNELS, source: "set with PI_REPLMODE_MAX_CHANNELS" };' "test/cap.test.ts"

run_mutation "R4-07 the channel parameter says nothing about the name length" src/index.ts ' +
        // R4-07: this is where a name is chosen, so this is where the rule that makes a call fail has to
        // be — the refusal alone leaves the model to discover it once a session.
        "A name is at most 200 characters: it names the log and history files of that channel.",
---MUTATE---
' "test/prompt.test.ts"

run_mutation "R4-07 the refusal forbids a length the tool accepts" src/manager.ts '        `invalid channel name: ${channelName.length} characters, and a name is ${MAX_CHANNEL_NAME_CHARS} at most — it names a channel, a log file and an IPython profile.`,
---MUTATE---
        `invalid channel name: ${channelName.length} characters. Keep it under ${MAX_CHANNEL_NAME_CHARS} — it names a channel, a log file and an IPython profile.`,
' "test/prompt.test.ts"

run_mutation "R4-08 the README promises a whole answer inside the limit again" README.md '`run` answer can come back a couple of kilobytes over 50 000 characters.
---MUTATE---
The limit covers the whole answer, the traceback included.' "test/prompt.test.ts"

run_mutation "F4-01 a quit looks only at the channels that finished starting" src/manager.ts '    const channels = [...this.channels.values(), ...this.halfStarted];
---MUTATE---
    const channels = [...this.channels.values()];' "test/lifecycle.test.ts"

run_mutation "F4-01 a start that outlived the quit is adopted by the next session anyway" src/manager.ts '    if (epoch !== this.quitEpoch) {
      // The session this call belonged to ended while the daemon was coming up: it has nobody left to
      // talk to it, and the next session will start its own.
      void channel.close();
---MUTATE---
    if (false && epoch !== this.quitEpoch) {
      void channel.close();' "test/lifecycle.test.ts"

run_mutation "F4-02 a channel the process table says is gone is still handed to the next call" src/manager.ts '    if (existing && !existing.closed && !processGone(existing.pid)) return existing;
---MUTATE---
    if (existing && !existing.closed) return existing;' "test/resilience.test.ts"

# ── pass 4's re-pins of pass 3's fixes (the tests exist to make these die) ────

run_mutation "R3-03 the digest is no longer the shape the digested-looking rule matches" src/names.ts '  return createHash("sha256").update(name).digest("hex").slice(0, DIGEST_CHARS);
---MUTATE---
  return createHash("sha256").update(name).digest("hex").toUpperCase().slice(0, DIGEST_CHARS);' "test/names.test.ts"

run_mutation "R3-10 capture between two cells is parked in the later cell's log as startup output" src/channel.ts '    if (this.lastClosed) {
      this.outOfBandOutput = true;
      this.lastClosed.lateWrite(chunk);
      return;
    }
---MUTATE---
    if (this.lastClosed && false) {
      this.outOfBandOutput = true;
      return;
    }' "test/lifecycle.test.ts"

run_mutation "R3-07 a second failed start truncates the file the first one pointed at" src/channel.ts '      appendFileSync(
        this.daemonLogPath,
        `\n[pi-replmode: output from the channel "${this.name}" process that failed to start (pid ${this.pid})]\n${parts.join("")}${capture}\n`,
        "utf8",
      );
---MUTATE---
      {
        const fd = openSync(this.daemonLogPath, "w");
        try {
          writeSync(
            fd,
            Buffer.from(
              `\n[pi-replmode: output from the channel "${this.name}" process that failed to start (pid ${this.pid})]\n${parts.join("")}${capture}\n`,
              "utf8",
            ),
          );
        } finally {
          closeSync(fd);
        }
      }' "test/lifecycle.test.ts"

run_mutation "R3-09 the line total comes from the cut rather than from the file" src/manager.ts '      const totalLines = Math.max(file.lines, cut.totalLines);
---MUTATE---
      const totalLines = cut.totalLines;' "test/limits.test.ts"

echo "=================================================="
echo "MUTATIONS RUN: $TOTAL — noticed: $NOTICED — SURVIVED: ${#SURVIVED[@]}"
for s in "${SURVIVED[@]}"; do echo "  survived: $s"; done
git status --short
