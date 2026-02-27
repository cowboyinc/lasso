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

## Getting Started

```bash
npm install
npm run dev
```

On launch, Lasso checks the current directory for a `.cowboy/` project. If none is found, run `init` to create one:

```
init dev
```

This initializes the project, generates a wallet, and scaffolds a starter actor.

## Commands

### General

| Command | Description |
|---------|-------------|
| `init <dev\|local>` | Initialize project environment |
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

Lasso runs as a persistent terminal session built with [Ink](https://github.com/vadimdemedes/ink). Commands are parsed locally and dispatched to the `cowboy` CLI as subprocesses. Some commands have additional behavior:

- **`init`** extracts the wallet address from the CLI output and saves it to `~/.lasso/config.json`
- **`actor deploy`** extracts the actor address and tracks it locally
- **`actor list`** is a lasso-only command that lists all actors you've deployed from this console

The status bar at the bottom shows the current network, project status, and wallet address.

## Configuration

Config is stored at `~/.lasso/config.json` and includes:

- `validatorUrl` - the target validator endpoint
- `walletAddress` - your wallet address (set after `init`)
- `actors` - array of deployed actor addresses

## License

MIT
