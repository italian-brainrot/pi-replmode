#!/usr/bin/env bash
# Does the extension keep out of a system prompt the user overrode?
#
# The claim is about pi's *rendered* prompt, not about what our handler returns, so it is checked
# against a real pi run: the session file stores the system message with its sections, and that is what
# the provider is sent. Three runs against one throwaway agent dir:
#
#   1. two `run` calls, so the next session has a lost-channel listing to make;
#   2. a second session with pi's own prompt — the listing must be in `rules`, and there must be no
#      `<replmode>` section anywhere;
#   3. a third session with `SYSTEM.md` in the agent dir — no pi-replmode text may reach the prompt at
#      all, while the notification still reaches the user.
#
# Cost: three model calls. Usage: bash scripts/smoke-prompt-surface.sh [agent-dir]
set -u

AGENT="${1:-/tmp/pi-replmode-prompt-smoke}"
REPO=$(cd "$(dirname "$0")/.." && pwd)

rm -rf "$AGENT"
mkdir -p "$AGENT"
cp ~/.pi/agent/auth.json ~/.pi/agent/models.json "$AGENT/"
# `qwen38-flash-next` is calibrated for thinking enabled: leave it on or the smoke behaves oddly.
printf '{"packages":["%s"],"defaultProvider":"strata","defaultModel":"qwen38-flash-next","defaultThinkingLevel":"low","defaultTools":[]}' "$REPO" > "$AGENT/settings.json"

pi_run() { PI_CODING_AGENT_DIR="$AGENT" pi --no-builtin-tools -p "$1"; }

latest_session() { find "$AGENT"/sessions -name "*.jsonl" -printf "%T@ %p\n" 2>/dev/null | sort -nr | head -1 | cut -d" " -f2-; }

# What the provider was actually sent, as one blob: every system message of the session, minus any
# section named later (pi quotes AGENTS.md and the cwd, and both mention pi-replmode by name — that is
# the user's own text, not this extension's contribution, so it is out of what gets grepped).
system_prompt() {
  node -e '
    const fs = require("fs");
    const [file, ...skip] = process.argv.slice(1);
    const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    for (const entry of entries) {
      const m = entry.message ?? entry;
      if (m.role !== "system") continue;
      if (m.content) console.log(m.content);
      for (const [name, text] of Object.entries(m.sections ?? {})) {
        console.log(`# section: ${name}`);
        if (!skip.includes(name)) console.log(text);
      }
    }
  ' "$@"
}

echo "== run 1: two cells on one channel, so a later session has something to report"
pi_run "Use the run tool twice: set answer = 6*7, then print(answer)." | tail -2

echo
echo "== run 2: pi's own prompt"
pi_run "Say OK." > /dev/null
S2=$(latest_session)
echo "sections: $(system_prompt "$S2" | grep -oP "(?<=^# section: ).*" | sort -u | tr "\n" " ")"
P2=$(system_prompt "$S2" project_context)
check() { # check <ok-message> <pattern> — present
  if echo "$P2" | grep -qF "$2"; then echo "ok: $1"; else echo "FAIL: $1 — not found: $2"; fi
}
echo "$P2" | grep -q "^<replmode>$" && echo "FAIL: a <replmode> section is in the prompt" || echo "ok: no <replmode> section"
check "the lost-channel listing is in pi's guidelines" "pi-replmode: these channels ran in an earlier pi process"
check "the run tool's own guidelines reached pi's rules" "Channels are capped"
check "the kill escalation is stated in the rules" "bg_stop {kill: true}"

echo
echo "== run 3: the same session against a SYSTEM.md the user wrote"
printf 'Answer in one word. Do not mention the tools you have.\n' > "$AGENT/SYSTEM.md"
pi_run "Say OK." > /dev/null
S3=$(latest_session)
echo "sections: $(system_prompt "$S3" | grep -oP "(?<=^# section: ).*" | sort -u | tr "\n" " ")"
P3=$(system_prompt "$S3" project_context)
echo "$P3" | grep -q "Answer in one word" && echo "ok: SYSTEM.md is the prompt" || echo "FAIL: SYSTEM.md was not used"
# Only our own sentences: pi quotes AGENTS.md and the cwd, and both contain the word "pi-replmode".
OURS='^<replmode>$|pi-replmode: |Channels are capped|idlest one is retired'
if echo "$P3" | grep -qE "$OURS"; then
  echo "FAIL: the extension wrote into an overridden prompt:"
  echo "$P3" | grep -E "$OURS"
else
  echo "ok: nothing this extension says is in the overridden prompt"
fi
echo "(the run tool is still declared: $(node -e '
  const fs = require("fs");
  const entries = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const names = new Set();
  for (const entry of entries) for (const t of entry.message?.toolsAdded ?? []) names.add(t.name);
  console.log([...names].join(", ") || "none recorded");
' "$S3")"

echo
echo "Sessions: $S2"
echo "          $S3"
echo "Agent dir left in place for inspection: $AGENT"
