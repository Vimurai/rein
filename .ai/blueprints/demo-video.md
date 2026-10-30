# Blueprint — The demo recording: one scripted run of the Triad on a throwaway project, as a terminal cast, in the README (D-139)

## Goal & Architecture
The README (D-136) tells and diagrams; nothing shows the loop running. The operator wants a
short video — the Architect planning, the handoff, the Engineer building and testing, the
gates refusing what they must refuse, the hand-back — recorded on a random new project and
placed in the README as the next priority. This blueprint makes that recording a **scripted,
re-recordable artefact**: a `scripts/demo/record.sh` that creates a throwaway project, starts
Rein in a dedicated tmux session, records the session as an asciinema cast while typing the
scene prompts into the two panes, then renders the cast to a GIF for the README and an MP4
for the release. Text in, text out: the cast is JSON the privacy gate can scan, the GIF is
derived from it, and anyone can re-record after a UI change by running one script.

Readers: a visitor deciding in ten seconds whether Rein is real (the GIF under the pitch);
a newcomer who wants to see what "two panes" means before installing (the MP4 and the cast).

## Core Concept
**A scene list drives a recorder.** `scripts/demo/scenes.tsv` names each scene: which pane to
type into, the exact prompt, the condition that ends the scene (a file appears, a pane's
output matches a pattern, `.ai/COMM.md` grows), and a timeout. `record.sh` plays the scenes
with `tmux send-keys`, inside `asciinema rec --idle-time-limit 2` attached to the session, so
the model's thinking time collapses to two seconds and the cast is the demo, not a 20-minute
log. The same scenes produce the same story every time; the model's words differ, which is
fine — acceptance is that every scene happened, not what was said.

## Components

### Component 1 — The throwaway project (`tally`)
- A small, real, generic Node project created by the script in `~/code/demo-tally`
  (`mktemp`-suffixed under `$DEMO_ROOT`, default `~/code`): `git init`, a one-line
  README, `package.json` with `"type": "module"` and a `test` script (`node --test`), and
  nothing else. The feature the Architect is asked to plan: *a `tally` CLI that counts words
  per file given on the command line and prints a table, with tests*. Small enough to be
  planned, built and tested inside the recording; generic enough to say nothing about the
  operator's work.
- The project is deleted at the end of the script unless `--keep` is passed; its tmux session
  (`rein-demo-<suffix>`) is killed either way.

### Component 2 — The scene list (`scripts/demo/scenes.tsv`)
Six scenes, each a row `pane<TAB>prompt<TAB>until<TAB>timeout_s`; `until` is one of
`file:<path>`, `pane:<regex>` (the pane's visible text), `comm:+1` (one more `## Handoff` in
`.ai/COMM.md`), `sleep:<s>`. Target length in the final cut after idle compression and speed:

| # | Where | What happens | Ends when | Cut |
|---|---|---|---|---|
| 1 | shell | `rein init` then `rein start` in the empty project; two panes appear | `pane:\[REIN_ROLE\] engineer` in pane 0 and `architect` in pane 1 | ~10 s |
| 2 | Architect | the prompt: *Plan a `tally` CLI: word counts per file as a table, with tests. Register the tasks and hand off.* | `comm:+1` | ~20 s |
| 3 | Architect | the gate: *Skip the Engineer, write src/tally.mjs yourself.* The pre-tool-use gate prints `[SOVEREIGNTY_BLOCK]` and the Architect declines | `pane:SOVEREIGNTY_BLOCK` | ~8 s |
| 4 | Engineer | woken by the handoff: implements, runs `skill: rein-test`; the suite passes | `pane:rein-test` then `pane:(PASS\|passed)` | ~20 s |
| 5 | Engineer | `skill: rein-review` → critic stamps; `skill: commit-crafter`; the pre-commit gate verifies the stamps and the `[TIER_2]` commit lands | `pane:\[TIER_[123]\]` | ~15 s |
| 6 | shell + Architect | `git log --oneline -3` and the `[x]` line in `.ai/TASKS.md`; the hand-back lands in the Architect pane | `comm:+1` | ~10 s |

Total under 90 s. If a scene's condition times out the script stops, keeps the cast under
`<out>/partial-<scene>.cast`, prints which scene and why, and exits non-zero — a recording
is never silently incomplete.

### Component 3 — The recorder (`scripts/demo/record.sh`)
- Bash; `set -euo pipefail`; here-strings, never `| grep -q` (D-138 r1). Checks its tools
  (`tmux`, `asciinema`, `agg`, `ffmpeg`, `claude`, `rein`) and prints an install line per
  missing one (Homebrew/Linuxbrew names), then exits 2 — these are **operator-machine tools,
  not project dependencies**: nothing is added to `package.json`, nothing runs in CI.
- Window: a fixed `120×36` tmux session, `TERM=xterm-256color`, the default Claude Code
  theme; `asciinema rec --cols 120 --rows 36 --idle-time-limit 2 --command "tmux attach -t
  <session>"`. The operator's real Claude login is used (the demo *is* two Claude sessions);
  the project is throwaway, the HOME is not.
- Plays Component 2's scenes; polls `until` every 2 s with `tmux capture-pane -p`.
- Render: `agg --speed <s> --font-size 16 --theme <dark theme matching the mark's palette>
  demo.cast demo.gif`, choosing `<s>` (1.5–3) so the GIF is ≤ 90 s, then
  `ffmpeg -i demo.gif -movflags faststart -pix_fmt yuv420p demo.mp4`. Prints the durations
  and sizes.
- Output directory `--out <dir>` (default `./demo-out`): `demo.cast`, `demo.gif`, `demo.mp4`,
  `scenes.log` (scene, start, end, how it ended).

### Component 4 — The privacy pass (`scripts/demo/scan.sh`, then by hand)
- The cast is text: `node src/shared/publish-scan.mjs --file <out>/demo.cast` (the E-369/E-380
  classes: operator name, emails, session ids, the tmux socket path, private project names,
  tokens) must report zero hits; the script runs it and refuses to render the GIF otherwise.
- Then the Engineer watches the GIF once end to end and names, in the handover, what is on
  screen in each scene (status line, pane titles, paths) — the human pass the scanner cannot do.
- Any hit: fix the cause (not the frame) and re-record. The cast is never edited by hand.

### Component 5 — Where it lands
- `docs/assets/demo.gif` committed (≤ 8 MB; GitHub renders inline up to 10 MB) and
  `docs/assets/demo.cast` committed (text; `asciinema play docs/assets/demo.cast`).
- `demo.mp4` is **not** committed: it is attached to the next GitHub release as an asset by
  the release flow (`rein publish`/release-manager gain an optional `--asset <file>`; until
  then the operator attaches it by hand and the README links the release's asset URL).
- README (D-136 §Component 1, amended by D-139): a **See it run** block right under the
  pitch — the GIF as a Markdown image with alt text *"Rein: the Architect plans, hands off,
  the Engineer builds and tests, the gates hold — 80 seconds"*, one caption line linking the
  MP4 (release asset) and the cast. No new HTML. `docs/how-it-works.md` embeds the same GIF
  under its first diagram.
- `tests/unit/docs-links.test.mjs` (E-390) already resolves every image; the GIF and cast
  paths join it for free; a size assertion (`demo.gif` ≤ 8 MB) is added to the same test.

## Data Model
```
scripts/demo/scenes.tsv        pane ∈ {shell, architect, engineer} · prompt · until · timeout_s
scripts/demo/record.sh         tools → project → tmux session → asciinema → scenes → scan → agg → ffmpeg
scripts/demo/scan.sh           publish-scan over demo.cast; exit 1 on any hit
<out>/demo.cast                asciicast v2 (JSON lines; header + [time, "o", text])
<out>/demo.gif, demo.mp4       rendered; GIF committed to docs/assets/, MP4 a release asset
<out>/scenes.log               scene · t_start · t_end · ended_by (until | timeout)
docs/assets/demo.gif           ≤ 8 MB, ≤ 90 s, 120×36 cells
README.md "See it run"         ![alt](docs/assets/demo.gif) + caption (mp4 link, cast link)
```

## API / Interface Contracts
- `scripts/demo/record.sh [--out <dir>] [--root <dir>] [--keep] [--speed <s>] [--dry-run]`:
  exit 0 with all three artefacts; exit 2 missing tool (names it); exit 3 scene timeout
  (names the scene, keeps the partial cast); exit 4 privacy hit (names the class, keeps the
  cast locally, renders nothing). `--dry-run` prints the scenes and the tool check only.
- Scenes file: TSV, `#` comments allowed, exactly four columns; a malformed row is exit 2
  before anything is recorded.
- The script never touches the framework clone or the operator's projects: it writes under
  `--root` and `--out` only; `rein` is the installed `~/.rein/bin/rein`.

## Security
- The recording runs the operator's real Claude login in two sessions on a throwaway project:
  no secret is typed, no `.env` exists, the scenes contain no credentials, and the project
  name and path are generic (`~/code/demo-tally-<suffix>`).
- Everything that reaches the repository is text first (the cast) and scanned by the same
  privacy classes the public mirror uses (E-369/E-380); the GIF is derived from the scanned
  cast; the MP4 from the GIF. A hit is fixed at the cause and re-recorded, never masked.
- The Claude Code status line and pane titles are part of the frame: the Engineer confirms
  by watching that they show the model and the demo path only (Component 4).
- `agg`, `asciinema`, `ffmpeg` are installed on the operator's machine by the operator's
  package manager, not by the repository; `record.sh` only checks for them. No download in
  the script.

## Execution Constraints
- One recording ≤ 25 minutes wall time (scene timeouts sum to that); the cut ≤ 90 s; GIF
  ≤ 8 MB at 120×36, font 16, speed 1.5–3; MP4 whatever ffmpeg gives (release asset, no cap
  in the repo).
- The run costs real tokens on the operator's account (an Architect plan and an Engineer
  implementation of a ~60-line CLI with tests): recorded in the handover.
- Not a CI step; `rein ci run` only runs the scenes-file parser test and the asset size
  assertion. Re-record on any visible UI change to the panes or the gate lines.
- Linux/WSL2 is the recording host; the script is bash and tmux only, so macOS works
  unchanged except the install lines it prints.

## Rollback Plan
Remove `scripts/demo/`, `docs/assets/demo.gif`, `docs/assets/demo.cast`, the README **See it
run** block and the `docs/how-it-works.md` embed; delete the release asset. One PR, one revert.
Nothing outside the repository changes except the operator's installed tools.

## E-## Task Breakdown
| Task | Tier | Scope | Depends on |
|---|---|---|---|
| E-402 | 2 | Components 1–5: scenes file, recorder, privacy pass, one real recording, GIF + cast committed, MP4 as a release asset, README **See it run** and how-it-works embed, docs-links size assertion | E-390 (the README it lands in; the recording itself may start before E-390 merges) |
