#!/usr/bin/env bash
# record.sh — record the Rein demo: the Architect plans, hands off, the Engineer builds and
# tests, the gates hold (D-139, .ai/blueprints/demo-video.md §Components 1–3, §API).
#
#   scripts/demo/record.sh [--out <dir>] [--root <dir>] [--keep] [--speed <s>] [--dry-run]
#                          [--scenes <file>]
#
# Creates a throwaway `tally` project under --root, starts a dedicated 120×36 tmux server,
# records it with asciinema (idle time capped at 2 s) while a background driver types each
# scene of scenes.tsv into its pane and waits for the scene's condition, then scans the cast
# with the privacy gate and renders demo.gif (agg) and demo.mp4 (ffmpeg).
#
# Run it in your own terminal: the two panes are real Claude Code sessions on your login, and
# you answer their permission prompts as they come (the idle cap hides the waits). The tools
# are operator-machine tools, not project dependencies: nothing here runs in CI.
#
# Exit: 0 all three artefacts · 2 usage, malformed scenes file or missing tool · 3 a scene timed
# out (the partial cast is kept) · 4 the privacy scan found something (nothing is rendered).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENES="${HERE}/scenes.tsv"
OUT="./demo-out"
# Outside $HOME on purpose: Claude Code shows its working directory, and a /home/<user>/… path
# on screen is a privacy finding (home_path) that would refuse the whole recording.
ROOT="/tmp/rein-demo"
KEEP=0 SPEED="" DRY=0
TOOLS=(tmux asciinema agg ffmpeg claude rein node)

_tilde() { local p="$1"; [[ -n "${HOME:-}" && "$p" == "$HOME"* ]] && p="~${p#"$HOME"}"; printf '%s' "$p"; }
_die() { echo "record.sh: $2" >&2; exit "$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --root) ROOT="${2:?--root needs a directory}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --speed) SPEED="${2:?--speed needs a number}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --scenes) SCENES="${2:?--scenes needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) _die 2 "unknown argument: $1 (see --help)" ;;
  esac
done
[[ -z "$SPEED" || "$SPEED" =~ ^[0-9]+(\.[0-9]+)?$ ]] || _die 2 "--speed must be a number"

# ── The scenes file: four TAB-separated columns per row; anything else is exit 2 before any
# recording starts (§API).
S_PANE=() S_PROMPT=() S_UNTIL=() S_TIMEOUT=()
_cond_ok() {
  [[ "$1" =~ ^(file|pane|architect|engineer):.+$ || "$1" =~ ^comm:\+[1-9][0-9]*$ || "$1" =~ ^sleep:[0-9]+$ ]]
}
# _conds "<a ; b ; c>" → one condition per line, trimmed (DATA on stdout only). The split is
# `IFS=';' read`, scoped to that one command: a function-wide `local IFS=';'` leaks into every
# function called under it (bash's dynamic scope) and broke `read -r id role` in _pane_of.
# Callers read it line by line (never `for c in $(…)`: a regex like \[TIER_[123]\] would glob).
_conds() {
  local parts c
  IFS=';' read -ra parts <<< "$1"
  for c in "${parts[@]}"; do
    c="${c#"${c%%[![:space:]]*}"}"; c="${c%"${c##*[![:space:]]}"}"
    [[ -n "$c" ]] && printf '%s\n' "$c"
  done
  return 0
}
_parse_scenes() {
  [[ -f "$SCENES" ]] || _die 2 "no scenes file: $(_tilde "$SCENES")"
  local n=0 line pane prompt until timeout rest c
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    IFS=$'\t' read -r pane prompt until timeout rest <<< "$line"
    [[ -n "$pane" && -n "$prompt" && -n "$until" && -n "$timeout" && -z "${rest:-}" ]] \
      || _die 2 "$(_tilde "$SCENES"):${n}: expected four TAB-separated columns (pane, prompt, until, timeout_s)"
    [[ "$pane" =~ ^(shell|architect|engineer)$ ]] || _die 2 "$(_tilde "$SCENES"):${n}: pane must be shell, architect or engineer (got '${pane}')"
    [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || _die 2 "$(_tilde "$SCENES"):${n}: timeout_s must be a positive whole number"
    while IFS= read -r c; do
      _cond_ok "$c" || _die 2 "$(_tilde "$SCENES"):${n}: unknown condition '${c}'"
    done < <(_conds "$until")
    S_PANE+=("$pane"); S_PROMPT+=("$prompt"); S_UNTIL+=("$until"); S_TIMEOUT+=("$timeout")
  done < "$SCENES"
  [[ ${#S_PANE[@]} -gt 0 ]] || _die 2 "$(_tilde "$SCENES"): no scenes"
}
_parse_scenes

_install_line() {
  case "$1" in
    claude) echo "  claude     — curl -fsSL https://claude.ai/install.sh | bash   (https://code.claude.com/docs/en/setup)" ;;
    rein)   echo "  rein       — bash install-rein.sh in a Rein clone (docs/install.md)" ;;
    node)   echo "  node       — brew install node" ;;
    *)      printf '  %-10s — brew install %s\n' "$1" "$1" ;;
  esac
}
_missing_tools() { local t; for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || printf '%s\n' "$t"; done; }

if [[ "$DRY" -eq 1 ]]; then
  echo "scenes ($(_tilde "$SCENES")):"
  for i in "${!S_PANE[@]}"; do
    printf '  %d  %-9s  %-48.48s  until %s  (%ss)\n' "$((i + 1))" "${S_PANE[$i]}" "${S_PROMPT[$i]}" "${S_UNTIL[$i]}" "${S_TIMEOUT[$i]}"
  done
  missing="$(_missing_tools)"
  if [[ -z "$missing" ]]; then echo "tools: all present (${TOOLS[*]})"
  else echo "tools missing:"; while IFS= read -r t; do _install_line "$t"; done <<< "$missing"; fi
  exit 0
fi

missing="$(_missing_tools)"
if [[ -n "$missing" ]]; then
  echo "record.sh: missing tools — install them first (operator machine, not the project):" >&2
  while IFS= read -r t; do _install_line "$t" >&2; done <<< "$missing"
  exit 2
fi

# ── Component 1: the throwaway project ────────────────────────────────────────
mkdir -p "$ROOT" "$OUT"
OUT="$(cd "$OUT" && pwd)"
PROJ="$(mktemp -d "${ROOT%/}/demo-tally-XXXXXX")"
SUFFIX="${PROJ##*-}"
SOCK="rein-demo-${SUFFIX}"
SESSION="rein-demo-${SUFFIX}"
T=(tmux -L "$SOCK")
CAST="${OUT}/demo.cast"
STATUS="${OUT}/.driver-status"
LOG="${OUT}/scenes.log"
rm -f "$STATUS"
: > "$LOG"

_cleanup() {
  "${T[@]}" kill-server 2>/dev/null || true
  if [[ "$KEEP" -eq 0 && "$PROJ" == "${ROOT%/}"/demo-tally-* && -d "$PROJ" ]]; then rm -rf -- "$PROJ"; fi
}
trap _cleanup EXIT

(
  cd "$PROJ"
  git init -q
  printf '# tally\n\nCount the words in files.\n' > README.md
  printf '{\n  "name": "tally",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > package.json
  git add README.md package.json
  git -c user.name=demo -c user.email=demo@example.invalid commit -q -m "tally: empty project"
)

# ── Component 3: the recorded tmux server — fixed 120×36, a plain prompt, its own socket so
# nothing touches your own tmux. Panes rein start opens inherit the same shell and prompt.
"${T[@]}" -f /dev/null new-session -d -s "$SESSION" -x 120 -y 36 -c "$PROJ" \
  "env PS1='$ ' bash --norc --noprofile"
"${T[@]}" set -g default-command "env PS1='$ ' bash --norc --noprofile"
"${T[@]}" set -g window-size manual
"${T[@]}" set -g default-size 120x36
"${T[@]}" set -g history-limit 5000
# The default status-right is the host name and a clock: the machine's name stays off the record.
"${T[@]}" set -g status-right ""
# Claude Code warns in-frame when tmux does not pass focus events.
"${T[@]}" set -g focus-events on
SHELL_PANE="$("${T[@]}" display-message -p -t "$SESSION" '#{pane_id}')"

_pane_of() {   # <shell|architect|engineer> → pane id, or nothing while that pane does not exist
  case "$1" in
    shell) printf '%s' "$SHELL_PANE" ;;
    *) local id role
       while read -r id role; do [[ "$role" == "$1" ]] && { printf '%s' "$id"; return 0; }; done \
         < <("${T[@]}" list-panes -a -F '#{pane_id} #{@rein_role}' 2>/dev/null)
       return 0 ;;
  esac
}
_visible() { local id; id="$(_pane_of "$1")"; [[ -n "$id" ]] && "${T[@]}" capture-pane -p -t "$id" 2>/dev/null; return 0; }
_handoffs() { local n=0; [[ -f "${PROJ}/.ai/COMM.md" ]] && { n="$(grep -c '^## Handoff' "${PROJ}/.ai/COMM.md")" || true; }; printf '%s' "${n:-0}"; }

_met() {   # <condition> <scene pane> <comm baseline> → 0 when met
  local c="$1" scene_pane="$2" base="$3" text
  case "$c" in
    file:*) [[ -e "${PROJ}/${c#file:}" ]] ;;
    pane:*) text="$(_visible "$scene_pane")"; [[ "$text" =~ ${c#pane:} ]] ;;
    architect:*) text="$(_visible architect)"; [[ "$text" =~ ${c#architect:} ]] ;;
    engineer:*) text="$(_visible engineer)"; [[ "$text" =~ ${c#engineer:} ]] ;;
    comm:+*) [[ "$(_handoffs)" -ge $((base + ${c#comm:+})) ]] ;;
    sleep:*) sleep "${c#sleep:}" ;;
  esac
}

_drive() {
  local i id start deadline base c ended
  # Start once asciinema's client is attached, so scene 1 is on the recording.
  for _ in $(seq 1 60); do [[ -n "$("${T[@]}" list-clients 2>/dev/null)" ]] && break; sleep 0.5; done
  "${T[@]}" send-keys -t "$SHELL_PANE" 'clear' Enter
  sleep 1
  for i in "${!S_PANE[@]}"; do
    start=$SECONDS; deadline=$((SECONDS + S_TIMEOUT[i])); base="$(_handoffs)"; ended=until
    if [[ "${S_PROMPT[$i]}" != "-" ]]; then
      id=""
      while [[ -z "$id" && $SECONDS -lt $deadline ]]; do id="$(_pane_of "${S_PANE[$i]}")"; [[ -n "$id" ]] || sleep 2; done
      if [[ -n "$id" ]]; then
        "${T[@]}" send-keys -t "$id" -l -- "${S_PROMPT[$i]}"
        sleep 0.5
        "${T[@]}" send-keys -t "$id" Enter
      fi
    fi
    while IFS= read -r c; do
      until _met "$c" "${S_PANE[$i]}" "$base"; do
        [[ $SECONDS -lt $deadline ]] || { ended=timeout; break 2; }
        sleep 2
      done
    done < <(_conds "${S_UNTIL[$i]}")
    printf '%d\t%d\t%d\t%s\t%s\n' "$((i + 1))" "$start" "$SECONDS" "$ended" "${S_UNTIL[$i]}" >> "$LOG"
    if [[ "$ended" == timeout ]]; then
      printf '3 %d\n' "$((i + 1))" > "$STATUS"
      "${T[@]}" kill-server 2>/dev/null || true
      return 0
    fi
  done
  sleep 3
  printf '0\n' > "$STATUS"
  "${T[@]}" kill-server 2>/dev/null || true
}

echo "record.sh: project $(_tilde "$PROJ"), ${#S_PANE[@]} scenes, recording to $(_tilde "$CAST")"
echo "record.sh: answer the panes' permission prompts as they appear; the recording ends by itself."
_drive &
DRIVER=$!
REC=(asciinema rec -q -f asciicast-v2 --window-size 120x36 --idle-time-limit 2 --overwrite
     -c "tmux -L ${SOCK} attach -t ${SESSION}")
[[ -t 0 && -t 1 ]] || REC+=(--headless)
"${REC[@]}" "$CAST" || true
wait "$DRIVER" || true

read -r code scene < "$STATUS" 2>/dev/null || { code=3; scene="?"; }
if [[ "$code" != 0 ]]; then
  mv -f "$CAST" "${OUT}/partial-${scene}.cast" 2>/dev/null || true
  echo "record.sh: scene ${scene} timed out — partial cast $(_tilde "${OUT}/partial-${scene}.cast"); see $(_tilde "$LOG")" >&2
  exit 3
fi

# ── Component 4: nothing is rendered from a cast the privacy gate has not cleared.
if ! bash "${HERE}/scan.sh" "$CAST"; then
  echo "record.sh: privacy finding in the cast — fix the cause and re-record (the cast stays at $(_tilde "$CAST"), nothing rendered)" >&2
  exit 4
fi

# ── Render from a copy that stops where tmux leaves its alternate screen, so the GIF ends on
# the panes, not on "[server exited]". The committed cast itself is never edited.
RENDER="${OUT}/.render.cast"
cut_at="$(grep -n '\[?1049l' "$CAST" | tail -n 1 | cut -d: -f1)" || true
if [[ "$cut_at" =~ ^[0-9]+$ && "$cut_at" -gt 2 ]]; then head -n "$((cut_at - 1))" "$CAST" > "$RENDER"; else cp "$CAST" "$RENDER"; fi

# ── Render: speed 1.5–3 so the GIF is at most 90 s, unless --speed says otherwise.
last="$(tail -n 1 "$RENDER")"
[[ "$last" =~ ^\[([0-9]+(\.[0-9]+)?) ]] || _die 3 "cannot read the cast's duration"
DUR="${BASH_REMATCH[1]}"
if [[ -z "$SPEED" ]]; then
  # d/90 rounded UP to a tenth (so the GIF never runs over 90 s), clamped to 1.5–3.
  SPEED="$(awk -v d="$DUR" 'BEGIN { s = int(d / 9 + 0.999) / 10; if (s < 1.5) s = 1.5; if (s > 3) s = 3; printf "%.1f", s }')"
fi
agg --speed "$SPEED" --font-size 16 --theme github-dark --idle-time-limit 2 --last-frame-duration 4 \
  "$RENDER" "${OUT}/demo.gif"
rm -f "$RENDER"
ffmpeg -y -loglevel error -i "${OUT}/demo.gif" -movflags faststart -pix_fmt yuv420p \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" "${OUT}/demo.mp4"

GIF_S="$(awk -v d="$DUR" -v s="$SPEED" 'BEGIN { printf "%.0f", d / s }')"
echo "record.sh: cast ${DUR%.*} s → demo.gif at ${SPEED}× ≈ ${GIF_S} s"
for f in demo.cast demo.gif demo.mp4 scenes.log; do
  printf '  %-10s %8s bytes  %s\n' "$f" "$(wc -c < "${OUT}/${f}")" "$(_tilde "${OUT}/${f}")"
done
[[ "$GIF_S" -le 90 ]] || echo "record.sh: the GIF runs over 90 s even at ${SPEED}× — tighten the scenes" >&2
