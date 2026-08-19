# Lasso

```
                                                  _  _
                                                 | || | _
                                                -| || || |
  ####   ###  ##   ## #####   ###  ##  ##        | || || |-
 ##  ## ## ## ##   ## ##  ## ## ## ##  ##         \ \_ || |
 ##     ## ## ## # ## #####  ## ##  ####            |  _/
 ##  ## ## ## ## # ## ##  ## ## ##   ##            -| | \
  ####   ###   ## ##  #####   ###   ##              |_|-
```

An interactive terminal console for the Cowboy blockchain. Lasso wraps the `cowboy` CLI into a persistent session with project detection, command history, and local state tracking.

## Install

```bash
brew install cowboyinc/tap/lasso
```

(The fully-qualified name matters — plain `lasso` is an unrelated SAML library in homebrew-core.)

Or run from source:

```bash
npm install
npm run dev
```

## Getting Started

Lasso connects to **mesa**, the public Cowboy devnet, by default — no setup required. New to Cowboy? Run `/walkthrough` for a guided tour of how the system works.

On launch, Lasso checks the current directory for a `.cowboy/` project. If none is found, run `/init` to create one:

```
/init           # mesa, the public devnet (default)
/init local     # a node you run yourself
```

This initializes the project, generates a wallet, requests faucet funds for it, and scaffolds a starter actor. Wallets with a zero balance are automatically topped up from the faucet at launch; `/faucet` requests more any time.

## Commands

### General

| Command | Description |
|---------|-------------|
| `init [mesa\|local]` | Initialize project environment (default: mesa) |
| `walkthrough [n]` | Guided tour of how Cowboy works |
| `docs [topic]` | Browse bundled Cowboy reference docs |
| `faucet [address]` | Request devnet CBY (defaults to your wallet) |
| `help` | Show all available commands |
| `clear` | Clear the console |
| `exit` | Quit lasso |

### Actor

| Command | Description |
|---------|-------------|
| `actor deploy <file.py>` | Deploy an actor to the chain |
| `actor execute --actor <a> --handler <h> [--payload <json>]` | Execute an actor handler |
| `actor get --address <a>` | Get actor details |
| `actor address --code <f> --creator <c> --salt <s>` | Compute actor address |
| `actor new <name>` | Scaffold a new actor project |
| `actor list` | List deployed actors |
| `actor logs --address <a>` | View actor logs |

### Runner

| Command | Description |
|---------|-------------|
| `runner get --address <a>` | Get runner details |
| `runner list` | List all runners |
| `runner register --stake <amount>` | Register as a runner |

## How It Works

Lasso runs as a persistent terminal session built with [Ink](https://github.com/vadimdemedes/ink). Commands are parsed locally and dispatched to the `cowboy` CLI as subprocesses or sent straight to the validator RPC. Some commands have additional behavior:

- **`init`** extracts the wallet address from the CLI output and tracks it in `.cowboy/config.json`
- **`actor deploy`** extracts the actor address and tracks it locally
- **`actor list`** is a lasso-only command that lists all actors you've deployed from this console
- **`faucet`** and the launch-time auto-fund call the validator's `POST /faucet` endpoint directly
- **plain text** goes to the AI actor builder, grounded by a bundled Cowboy knowledge pack (see `/docs`) and any local `actors/*.py` files you reference by path

The status bar at the bottom shows the current network, project status, and wallet address.

## Keyboard Shortcuts

Lasso now uses a shared line editor for the command prompt and masked inputs.

- `Ctrl+A` / `Ctrl+E` move to the start or end of the line
- `Ctrl+B` / `Ctrl+F` or left/right arrows move one character
- `Alt+B` / `Alt+F` move by word when your terminal sends Meta/Option sequences
- `Ctrl+H` or Backspace deletes backward
- `Ctrl+D` or Delete deletes forward
- `Ctrl+U` clears from the cursor back to the start of the line
- `Ctrl+K` clears from the cursor to the end of the line
- `Ctrl+W` deletes the previous word
- Up/down arrows navigate command history in the main prompt
- `Ctrl+C` clears the line first; pressing it again on an empty prompt exits Lasso

macOS caveats:

- `Option` shortcuts depend on your terminal being configured to send Meta/Escape sequences. Terminal.app and iTerm2 may need an explicit Option-as-Meta setting for `Alt+B` / `Alt+F` to work.
- `Command` shortcuts are best-effort only. Most terminals keep `Command+Arrow` and similar combinations for local UI actions, so Lasso may never receive those key events.

## Configuration

Config is stored at `.cowboy/config.json` in the project directory (written by `cowboy init`, shared with the CLI). Per environment:

- `rpc_url` - the target validator endpoint (default: `https://rpc.mesa.cowboylabs.net`)
- `key_file` - wallet key location under `.cowboy/keys/`
- `dashboard_url` - dashboard API base URL (default: `https://dashboard.mesa.cowboylabs.net`); drives the AI builder and live actor lists
- `runner_url` - OpenAI-compatible runner endpoint; used by the AI builder only when `dashboard_url` is set to `""`
- `actors` - deployed actor addresses and labels

### AI builder backends

Plain-text prompts go to the Cowboy dashboard agent at
`https://dashboard.mesa.cowboylabs.net` (configurable via `dashboard_url`
in `.cowboy/config.json`). The agent generates actor code server-side;
lasso writes it to `actors/<name>/main.py` and suggests `/actor deploy`.

To use a direct vLLM runner instead (the pre-0.4 behavior), set
`"dashboard_url": ""` and point `runner_url` at your runner.

## License

Business Source License 1.1 — see [LICENSE](LICENSE).
