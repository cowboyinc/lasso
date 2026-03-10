# Changelog

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
