# Changelog

## [Unreleased]

### Added
- **Interactive `ask_user` (dashboard PR #177).** When the agent asks a blocking question, the console prints it (with numbered choices), lets you type an answer while the run stays parked (a bare number picks a choice; free text works too), and POSTs it to `/api/agent/answer-callback` so the same run resumes. Replaces the old turn-ending clarify cue.

### Removed
- **Dropped clarify rendering (dashboard PR #177 removed the `clarify` tool).** Asking the user now goes through `ask_user` (blocking); lasso interactive support for it is a follow-up.

### Added
- **Secret requests (doc 63 §9).** When the agent needs a secret set, the console prints a cue to set its value in the dashboard Secrets menu (the value never passes through the chat).
- **Clarify prompts (doc 63).** When the agent asks a question via the `clarify` tool, the console renders it as a numbered "reply to continue (pick one or type your own)" list so you can answer with a number or your own text.
- **Run-until-done agent mode (doc 61).** AI prompts now stream with `mode: "agent"`, so the console builds, tests, and self-corrects across steps before reporting (instead of the build-then-stop wizard). The transcript shows the agent's work as it goes: condensed `thinking:` lines from the model's reasoning, each `⚙ tool…` call, and its `✓`/`✗` result (e.g. simulation cycles/state changes) — so a build now reads as write → simulate → (fix) → report. Deploy still requires you to say "deploy it".
- **Live plan/todo checklist (doc 61 T1.4).** The agent's `plan` events render as an updating `Plan:` checklist (`[x]` done, `[~]` in progress, `[ ]` pending) so you can see the steps it's working through. The `update_plan` tool's own activity/result lines are suppressed (the checklist is the rendering).

## [0.4.3] - 2026-06-11

### Changed
- Banner restored to the original block wordmark + cactus (with its
  backslashes properly escaped, so the full cactus renders)

## [0.4.2] - 2026-06-11

### Changed
- The banner: Terrace-font Cowboy wordmark with the original cactus beside
  it. Banner rotation and `LASSO_BANNER` are gone — a winner was picked.
  The cactus's left arm renders for the first time (its backslashes had
  been unescaped since the original art landed).

## [0.4.1] - 2026-06-11

### Changed
- Three new launch banners (slant wordmark + lasso rope, big wordmark
  wearing the hat, the original cactus now properly dressed) rotating per
  launch while we pick a favorite; pin one with `LASSO_BANNER=0|1|2`

## [0.4.0] - 2026-06-10

### Changed
- The AI actor builder now drives the dashboard backend agent
  (`POST /api/agent/chat` on `dashboard.mesa.cowboylabs.net` by default) —
  the same agent loop, tools, and conversations as the dashboard frontend.
  Generated actors are still written to `actors/<name>/main.py` with a
  `/actor deploy` hint.
- `dashboard_url` now defaults to `https://dashboard.mesa.cowboylabs.net`.
  Set `"dashboard_url": ""` in `.cowboy/config.json` to opt out and use the
  direct `runner_url` vLLM path instead.
- Ctrl+C now cancels an in-flight AI stream (agent path; direct `runner_url`
  mode still waits for the response to complete).
- Because `dashboard_url` is now set by default, `/actor list` shows live
  dashboard data for initialized wallets instead of the local-only list.
- Agent output renders markdown (headings, bullet/numbered lists, italics,
  quotes, rules — on top of the existing bold/inline-code/code blocks), and
  the command echo no longer uses a hardcoded dark background that was
  unreadable on light terminal themes.
- The status bar AI indicator shows the active backend (`AI: dashboard`,
  `AI: direct`, or `AI: off`) instead of keying on `runner_url` alone.

### Known gaps
- Agent actions that need a wallet signature (deploy/transfer) are not yet
  supported from lasso; the builder points you at `/actor deploy` instead.

## [0.3.5] - 2026-06-10

### Added
- E2E smoke suite: `npm run test:e2e` drives the built TUI through a PTY
  with a canned cowboy CLI (banner, /docs, /walkthrough, init
  success/failure/missing-CLI, silent-failure truthfulness); runs in CI
- Update notice on launch when a newer GitHub release exists
  (`LASSO_NO_UPDATE_CHECK=1` to disable)

### Changed
- cowboy CLI exit codes are surfaced: nonzero exits render as errors
  across all commands; a silent failure reports "Command failed (exit N)"
  instead of "Command completed (no output)"
- "cowboy CLI not found" now includes the install hint
  (`brew install cowboyinc/lasso/cowboy`)

## [0.3.4] - 2026-06-10

### Fixed
- Init next-step suggests `actors/counter/main.py` — the starter actor init
  actually creates (was `actors/hello/main.py`, which doesn't exist)

## [0.3.3] - 2026-06-10

### Fixed
- `/init` no longer appends "Next step deploy your first Actor" to CLI
  errors (e.g. cowboy CLI missing from PATH); failures now render as errors

### Changed
- Homebrew: the lasso formula now depends on `cowboyinc/lasso/cowboy`, so
  `brew install cowboyinc/lasso/lasso` also installs the cowboy CLI
  (binaries from github.com/cowboyinc/cowboy-cli)

## [0.3.2] - 2026-06-10

### Changed
- Walkthrough lesson 1: dropped the "Erlang got it right" intro bullet

## [0.3.1] - 2026-06-10

### Added
- `lasso --version` / `-v` and `lasso --help` / `-h` print and exit instead
  of launching the TUI; unknown arguments error with usage (exit 1)

## [0.3.0] - 2026-06-10

### Added
- `/walkthrough` — interactive guided tour of how Cowboy works (9 lessons
  modeled on the erlangcowboydemo), advertised in the launch banner
- `/docs [topic]` — browse the bundled Cowboy knowledge pack
- `/faucet [address]` — request devnet CBY via `POST /faucet` (defaults to
  the session wallet)
- Auto-fund: wallets with a zero balance get a faucet drip at launch
- Cowboy knowledge pack (`src/knowledge/`): curated reference sections
  retrieved into the AI builder's system prompt per request
- AI builder reads local `actors/*.py` files referenced by path (capped at
  2 files / 3KB each to respect the 8k context budget)
- Makefile: `dev`, `build`, `test`, `typecheck`, `check`, `binary`,
  `binaries` (cross-compile + SHA256SUMS), `install-local`, `release`,
  `clean`
- Homebrew distribution: `brew tap cowboyinc/lasso && brew install lasso`

### Changed
- Default network is now mesa (`https://rpc.mesa.cowboylabs.net`), the
  public devnet, instead of `http://localhost:4000`
- `/init` defaults to mesa and accepts `mesa` as an alias for the cowboy
  CLI's `dev` network; `/init local` unchanged
- README documents the real `.cowboy/config.json` layout (the old
  `~/.lasso/config.json` reference was stale)

## [0.2.1] - 2026-05-17

### Added
- CI: `test` job runs `npm test` on PRs (typecheck + test) and gates the
  `build` job on main pushes (PR #15). Build step is now
  `if: github.event_name == 'push'` so PR runs don't touch S3 or use
  deploy secrets.

### Fixed
- `npm test` script: was using shell-expanded `src/**/*.test.ts` glob
  that mis-matched on the CI environment; replaced with the
  vitest-default pattern so all tests are discovered.

## [0.2.0] - 2026-04-24

### Added
- AI Actor Builder: plain text prompts now stream directly to runner's vLLM endpoint (no on-chain job submission)
- Multi-turn conversation: AI builder maintains conversation history across prompts, cleared on /clear
- Auto file writing: generated actor code is extracted and written to actors/<name>/main.py with dispatch shim
- Streaming display: LLM response streams token-by-token in the terminal
- runner_url config field in .cowboy/config.json for direct vLLM access
- System prompt with full Cowboy SDK reference (ported from dashboard actor-builder)
- Actor extractor with dispatch shim injection (ported from dashboard)
- Status bar shows AI builder status (on/off based on runner_url)

### Changed
- Plain text input no longer submits on-chain LLM jobs; calls runner directly via OpenAI-compatible API
- Status bar simplified: AI routing replaced with on/off indicator

## [0.1.4] - 2026-03-30

### Added
- Interactive token launch wizard: `token launch` walks through name, symbol, decimals, initial supply, and max supply with smart defaults and a confirmation summary
- `token list` now displays a formatted table instead of raw JSON
- Cowboy CLI version shown in status bar alongside lasso version
- `actor list` fetches actors from dashboard API (`GET /api/wallet/:address/actors`) with formatted table showing label, full address, balance, nonce, storage size, and deploy height
- `actor get <address>` displays a formatted key-value table instead of raw JSON, fetched directly from validator RPC
- Auto-detect wallet address from key file on startup
- `dashboard_url` config field for connecting to the dashboard backend

### Changed
- Bumped version to 0.1.4
- `actor get` and `actor logs` accept positional address (`actor get <addr>`) instead of requiring `--address` flag
- Actor list table shows full addresses for easy copy-paste
- Falls back to local-only actor list when `dashboard_url` is not configured

## [0.1.3] - 2026-03-13

### Changed
- Version bump to 0.1.3

## [0.1.2] - 2026-03-09

### Added
- Actor labels: `actor label <address|#> <text>` sets a human-readable label on deployed actors
- Auto-label on deploy: extracts filename as default label (e.g. `father_jokes.py` -> `father_jokes`, `hello/main.py` -> `hello`)
- `actor list` now shows labels next to addresses
- Auto-migration: old `string[]` actor configs are upgraded to `{address, label}` format on load

### Fixed
- Command parser now respects quoted strings (e.g. `--name "BTC Price"` no longer splits into `"BTC` and `Price"`)

### Changed
- `actor execute` default gas limits increased to 500K cycles/cells (was using CLI default 200K, insufficient for runner jobs)
- Config uses `.cowboy/config.json` only (removed `~/.lasso/config.json` global config)
- Actors stored per-environment in project config (`environments[active].actors`)
- Init reloads full session state from project config instead of merging with stale global
- `actor execute` accepts positional args: `actor execute <address> <method> [--payload <hex>]`
- Default payload to empty JSON (`7b7d`) when not provided

### Fixed
- Actor deploy: address regex now handles `0x` prefix (was capturing just `"0"`)
- Actor deploy: addresses stored with `0x` prefix for consistency
- Init: clears stale actors from previous environment
- Init: reads RPC URL from project config (`.cowboy/config.json`) instead of stale global config

### Removed
- `~/.lasso/config.json` global config file (single source of truth is now `.cowboy/config.json`)

### Added
- Binary promotion workflow (`.github/workflows/promote.yml`)
  - Tag-based promotion from dev S3 to stg/prd S3 (`stg-v*`, `prd-v*`)
  - Rewrites `bootstrap.sh` CDN URL from canyon to target terrain (mesa/summit)
  - OIDC auth chain: org role -> dev account (download) -> target account (upload)
  - Slack notifications on promotion success/failure
- Transfer command: `transfer --to <addr> --amount <cby>`
- Wallet commands: `create`, `address`, `balance`
- Token (CIP-20) commands: `create`, `transfer`, `approve`, `mint`, `burn`, `info`, `balance`, `list`
- Watchtower commands: `new feed`, `feed <id> publish`, `feed <id> subscribers`, `list`, `feeds`
- Block commands until project is initialized (only `init`, `help`, `clear`, `exit` allowed)

### Changed
- Read RPC URL from `.cowboy/config.json` instead of hardcoded constant
- After `init`, reload config to pick up the new RPC URL dynamically
- Help text updated with all new command groups

### Removed
- Hardcoded `VALIDATOR_URL` constant (now reads from project config)

## [0.1.1] - 2026-02-26

### Added
- Bun binary distribution pipeline (`.github/workflows/pipeline.yml`)
  - Typecheck job on all pushes to main
  - Cross-compile 4 platform binaries (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
  - Upload to S3 with versioned paths and `latest` pointer
  - Two-step AWS OIDC auth (org role -> dev account role)
  - Slack notifications on build success/failure
- `bootstrap.sh` installer script for downloading pre-built binaries
  - Detects OS and architecture automatically
  - Fetches latest version from CDN
  - Installs to `/usr/local/bin/lasso` with sudo password prompt
  - Falls back to `~/.local/bin` when no terminal is available
  - Usage: `LASSO_KEY=xxx ./bootstrap.sh`
- `react-devtools-core` dev dependency (required for Bun compilation of Ink)
- `bun.lock` lockfile for Bun package manager
- `build/` added to `.gitignore`

### Added
- Actor commands: `execute`, `get`, `address`, `new`, `list`, `logs`
- Runner commands: `get`, `list`, `register`
- `actor list` command (lasso-only) to show deployed actor addresses
- Generic `executeCowboy()` wrapper for all cowboy CLI commands
- `.cowboy/` project directory detection with startup warning
- `parseFlags()` helper for extracting `--key value` pairs from command input
- Wallet address extracted from `init` output and saved to config
- Actor addresses extracted from `deploy` output and saved to config
- Wallet address shown in status bar footer
- Command history navigation with up/down arrow keys

### Changed
- `init` now runs `cowboy init <env>` via CLI instead of interactive key form
- Help text now grouped by category (General, Actor, Runner)
- Command execution generalized to handle all cowboy CLI subcommands
- Deploy output truncated after success message for cleaner display
- Messages now have spacing between them for readability
- Command lines shown with subtle background highlight
- Replace `cowboy>` prompt with `❯` character

### Removed
- Interactive private key input form (cowboy CLI handles key storage via `.cowboy/`)

## [0.1.0] - 2026-02-26

### Added
- Initial project scaffold with Ink (React for terminal) + TypeScript
- ASCII "LASSO" logo header
- Command parsing: `init`, `deploy actor <file>`, `help`, `clear`, `exit`
- Private key input form (session-only, never persisted)
- Async subprocess executor for `cowboy` CLI with animated spinner
- Salt generation via Node.js `crypto.randomBytes`
- Config persistence at `~/.lasso/config.json`
- Status bar showing validator URL, key status, version
- Role-based message display (command/output/error/system)
