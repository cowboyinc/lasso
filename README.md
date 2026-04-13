# Lasso

An interactive terminal for Cowboy — evolving into an AI-powered operator console.

Lasso combines a persistent TUI, command execution, and native Cowboy tooling so you can build, inspect, and operate onchain actors without bouncing between shell commands, docs, and local state.

Think Codex or Claude Code — but with first-class access to Cowboy actors, wallets, tokens, runners, and Watchtower feeds.

---

## Quick Example

Start Lasso:

```bash
npm install
npm run dev
```

Then in the session:

```
init dev
actor new greeter
actor deploy actors/greeter/main.py
actor list
actor execute --actor <address> --handler greet --payload 0x
```

Lasso keeps track of your project, wallet, and deployed actors as you go — no need to re-specify context across commands.

---

## Why Lasso

The `cowboy` CLI is the source-of-truth interface for Cowboy. It is precise, composable, and scriptable.

Lasso is the interactive layer on top.

Using the CLI directly:

* each command is stateless
* no memory of deployed actors
* no persistent project context
* repeated flags and manual tracking

With Lasso:

* commands run inside a persistent session
* deployed actors are tracked automatically
* wallet + project context is always available
* you operate Cowboy like a system, not a series of commands

---

## What Lasso Manages

Lasso is designed to operate the full Cowboy stack from one interface:

* **actors** — deploy, inspect, execute, label, and track them
* **wallets** — create wallets, inspect balances, and transfer CBY
* **tokens** — launch and manage CIP-20 tokens
* **runners** — discover and manage compute providers
* **watchtower** — create feeds, publish data, and inspect subscribers
* **project state** — keep the active Cowboy project and tracked actors in sync

---

## Getting Started

```bash
npm install
npm run dev
```

On launch, Lasso checks for a `.cowboy/` project in the current directory.

If none exists, initialize one:

```
init dev
```

This will:

* create a project environment
* generate a wallet
* scaffold a starter actor

---

## Example Session

```
$ npm run dev

lasso> init dev
✔ Project initialized
✔ Wallet: 0x1234...

lasso> actor new greeter
✔ Created actors/greeter

lasso> actor deploy actors/greeter/main.py
✔ Deployed: 0xabcd...

lasso> actor list
0xabcd... (greeter)

lasso> actor execute --actor 0xabcd... --handler greet --payload 0x
✔ "Hello"
```

Lasso tracks deployed actors and wallet state automatically across commands.

---

## Commands

Most commands mirror the `cowboy` CLI, but run inside a persistent session.

### General

| Command                               | Description                    |
| ------------------------------------- | ------------------------------ |
| `init <dev\|local>`                   | Initialize project environment |
| `transfer --to <addr> --amount <cby>` | Transfer CBY to an address     |
| `help`                                | Show all available commands    |
| `clear`                               | Clear the console              |
| `exit`                                | Quit Lasso                     |

### Wallet

| Command                           | Description            |
| --------------------------------- | ---------------------- |
| `wallet create [--output <path>]` | Generate a new keypair |
| `wallet address [--key <path>]`   | Show wallet address    |
| `wallet balance [--key <path>]`   | Show wallet balance    |

### Actor

| Command                                               | Description                            |
| ----------------------------------------------------- | -------------------------------------- |
| `actor deploy <file.py>`                              | Deploy an actor to the chain           |
| `actor execute <address> <method> [--payload <json>]` | Execute an actor handler               |
| `actor get <address>`                                 | Get actor details                      |
| `actor address --code <f> --creator <c> --salt <s>`   | Compute actor address                  |
| `actor new <name>`                                    | Scaffold a new actor project           |
| `actor label <address\|#> <text>`                     | Set a label for a tracked actor        |
| `actor list`                                          | List deployed actors (tracked locally) |
| `actor logs <address>`                                | View actor logs                        |

### Runner

| Command                            | Description          |
| ---------------------------------- | -------------------- |
| `runner get --address <a>`         | Get runner details   |
| `runner list`                      | List all runners     |
| `runner register --stake <amount>` | Register as a runner |

### Token (CIP-20)

| Command                                                        | Description                       |
| -------------------------------------------------------------- | --------------------------------- |
| `token launch`                                                 | Interactive token creation wizard |
| `token create --name <n> --symbol <s> --initial-supply <n>`    | Create a new token                |
| `token transfer --token-id <id> --to <addr> --amount <n>`      | Transfer tokens                   |
| `token approve --token-id <id> --spender <addr> --amount <n>`  | Approve a spender                 |
| `token mint --token-id <id> --to <addr> --amount <n>`          | Mint tokens                       |
| `token burn --token-id <id> --amount <n>`                      | Burn tokens                       |
| `token info --token-id <id>`                                   | Show token info                   |
| `token balance --token-id <id> --address <addr>`               | Show token balance                |
| `token list`                                                   | List all tokens                   |

### Watchtower

| Command                                              | Description            |
| ---------------------------------------------------- | ---------------------- |
| `watchtower new feed --name <n> [--description <d>]` | Create a new data feed |
| `watchtower feed <id> publish --data <json>`         | Publish data to a feed |
| `watchtower feed <id> subscribers`                   | List feed subscribers  |
| `watchtower list`                                    | List all feeds         |
| `watchtower feeds`                                   | List your feeds        |

---

## Configuration

Lasso reads the active environment from:

```
.cowboy/config.json
```

Relevant fields include:

* `active` — the selected Cowboy environment
* `environments.<name>.rpc_url` — target validator endpoint
* `environments.<name>.dashboard_url` — optional dashboard API for richer actor listings
* `environments.<name>.wallet_address` — active wallet
* `environments.<name>.actors` — locally tracked actor addresses and labels

Lasso preserves the rest of the Cowboy project config and only updates the fields it needs.

---

## What’s Next

Start using Lasso as your working environment for Cowboy:

* deploy an actor
* interact with it in-session
* track your state as you go

Lasso turns the Cowboy CLI from a set of commands into a working environment — and eventually, an intelligent one.

## License

MIT
