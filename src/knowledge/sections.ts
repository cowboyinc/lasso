/**
 * Curated Cowboy knowledge pack.
 *
 * Hand-picked reference sections sourced from the cowboy docs
 * (cowboyinc/cowboy docs/), the node RPC surface, and the runner job
 * model. Deliberately curated: enough for Lasso and its AI builder to
 * understand the system, NOT a mirror of the cowboy source tree.
 *
 * Each section is small (roughly 200-500 tokens) so retrieval can fit
 * 2-3 sections into the AI builder's 8k context window.
 */

export interface KnowledgeSection {
  /** Stable topic id, used by /docs <topic>. */
  id: string;
  title: string;
  /** Lowercase match terms for retrieval scoring. */
  keywords: string[];
  body: string;
}

export const KNOWLEDGE_SECTIONS: KnowledgeSection[] = [
  {
    id: "architecture",
    title: "Cowboy architecture",
    keywords: ["architecture", "overview", "chain", "l1", "layer", "consensus", "validator", "pvm", "design", "system", "blockchain", "cowboy"],
    body: `Cowboy is a Layer 1 blockchain built for autonomous agents and verifiable off-chain computation.

Core components:
- Actor VM (PVM): a Rust-based deterministic Python interpreter. Actors (smart contracts) are Python classes. No JIT, software floating point, curated stdlib whitelist, no I/O or network syscalls.
- Consensus: Simplex BFT - deterministic finality, no reorgs, leader-based proposals with quorum certificates.
- Dual-metered gas: Cycles meter compute, Cells meter data. Priced independently.
- Native timers (CIP-1): protocol-level scheduling; an actor can run at a future block without an external keeper.
- Runners (CIP-2): decentralized off-chain compute for LLM / HTTP / MCP jobs, with verification modes and on-chain callbacks.
- CBFS: distributed, encrypted, erasure-coded file storage with volume attach for actors.
- Gateway: serves HTML/HTTP from actors and public CBFS volumes.

The cowboy_sdk (CIP-6) sits on top of the low-level pvm_host API: @actor decorator, CBOR auto-serialized self.storage, and a continuation FSM for async runner calls.`,
  },
  {
    id: "networks",
    title: "Networks: mesa, local, summit",
    keywords: ["network", "mesa", "devnet", "local", "summit", "mainnet", "rpc", "url", "endpoint", "connect", "init"],
    body: `Cowboy networks:
- mesa (public devnet): rpc at https://rpc.mesa.cowboylabs.net. Anyone can test here. The cowboy CLI calls this network "dev"; lasso accepts "mesa" and defaults to it.
- local: a node you run yourself, rpc at http://localhost:4000.
- summit (mainnet): not available yet.

A lasso/cowboy project is initialized with "/init" (mesa) or "/init local". Init creates .cowboy/keys/<network> (secp256k1 key, PEM), .cowboy/config.json (per-environment rpc_url/key_file with an "active" pointer), starter actors under actors/, and cowboy.toml. It then requests faucet funds for the new wallet.

Useful RPC endpoints (GET unless noted): /health, /height, /account/{address}, /actor/{address}, /actor/{address}/logs, /block/{hash}, /transaction/{hash}/receipt, /runners/active, /job/{id}/status, /job/{id}/results, /job/{id}/verified, POST /faucet.`,
  },
  {
    id: "wallet",
    title: "Wallets and CBY",
    keywords: ["wallet", "cby", "balance", "key", "address", "decimals", "wei", "transfer", "account", "fund"],
    body: `CBY is the native token. CBY has 9 decimals, not 18: 1 CBY = 10^9 wei. As a convention across the codebase, u64 amount fields hold whole CBY and u128 fields hold wei.

Wallets are secp256k1 keypairs; addresses are 20-byte hex (0x-prefixed, checksummed). Keys are stored under .cowboy/keys/<network> in PEM form.

Commands in lasso: /wallet create, /wallet address, /wallet balance, /wallet export [--no-prefix], /wallet import --hex <hex> | --mnemonic "<phrase>", /transfer --to <addr> --amount <cby>.

Balance lookup: GET /account/{address} returns {address, nonce, balance}; an account that has never received funds returns 404 (treat as 0).`,
  },
  {
    id: "faucet",
    title: "Faucet",
    keywords: ["faucet", "fund", "funding", "drip", "free", "cby", "testnet", "devnet", "money", "broke", "empty"],
    body: `Devnets (mesa, local) run a faucet at POST {rpc_url}/faucet with body {"address": "0x..."}. Each request transfers 5,000 CBY from a genesis faucet account and responds with {status, finality, tx_hash, amount, amount_cby}. The endpoint is rate-limited, and is only available when the node enables it and the faucet account exists in genesis.

In lasso: /faucet funds the session wallet, /faucet <address> funds any address. Lasso also auto-requests a drip at launch when the configured wallet's balance is 0, and /init requests one for newly created wallets. If the faucet replies "faucet account not found in genesis", that devnet was deployed without a faucet account - report it to the operators.`,
  },
  {
    id: "actors",
    title: "Actors and the PVM",
    keywords: ["actor", "actors", "smart", "contract", "python", "class", "handler", "deploy", "init", "pvm", "code", "decorator"],
    body: `Actors are Cowboy's smart contracts: Python classes running in the deterministic PVM. Each actor has an address, a CBOR key-value storage, a mailbox, and a CBY balance.

Structure: a class with the @actor decorator. init(self, payload) runs at deploy; every other method is a handler invoked via "actor execute". Handlers receive payload (bytes) and return bytes. Gas (cycles/cells) is metered automatically by the PVM as code runs.

Deploy computes the actor address from (code, creator, salt), so the same code+salt redeploys to the same address.

Allowed imports on-chain: cowboy_sdk, pvm_host, json, math, re, string, base64, struct, hashlib, hmac, cbor2, collections, enum, dataclasses, typing, functools, itertools, operator. Blocked (crash on import): time, datetime, random, os, sys, socket, subprocess, threading, pathlib, asyncio (except in @runner.continuation handlers).

Determinism: no wall clock, no randomness, software floats. Use block height (runtime.get_block_height()) for time-like logic.`,
  },
  {
    id: "storage",
    title: "Actor storage",
    keywords: ["storage", "state", "persist", "cbor", "self.storage", "key", "value", "mutate", "save", "data"],
    body: `Actor state lives in self.storage, a CBOR-serialized key-value store. Reads/writes auto-encode.

The most common bug: in-place mutation does NOT persist.
WRONG: self.storage['items'].append(x)
RIGHT: items = self.storage.get('items', []); items.append(x); self.storage['items'] = items

For unbounded growth, use a count plus indexed keys instead of one giant list:
count = self.storage.get('msg_count', 0)
self.storage[f'msg:{count}'] = data
self.storage['msg_count'] = count + 1

Storage writes are metered in Cells (the data half of dual-metered gas), so structure data to write only what changed. The legacy pvm_host API exposes raw bytes state via get_state/set_state.`,
  },
  {
    id: "gas",
    title: "Gas: Cycles and Cells",
    keywords: ["gas", "cycles", "cells", "fee", "fees", "cost", "limit", "meter", "charge", "basefee", "price"],
    body: `Cowboy meters gas on two independent axes:
- Cycles: compute (bytecode instructions executed).
- Cells: data (storage bytes written/held).

Each is priced separately (own basefee), so compute-heavy and data-heavy workloads don't bid against each other. Transactions carry cycles-limit and cells-limit; lasso defaults to 500k/500k for execute and 10M/10M for deploy.

The PVM meters both axes automatically as actor code runs - handlers do not charge gas explicitly. Exceeding a limit aborts the transaction.`,
  },
  {
    id: "messages",
    title: "Messages, mailboxes, events",
    keywords: ["message", "mailbox", "send", "send_message", "event", "emit", "async", "communicate", "actor-to-actor", "erlang", "deferred", "timer"],
    body: `Actors communicate like Erlang processes: asynchronous message passing, no shared memory.

- runtime.send_message(target, payload): enqueue a message to another actor's mailbox; data is copied. Delivery is asynchronous (next block), not a synchronous call.
- runtime.emit_event(name, payload): emit an on-chain event for off-chain consumers (explorers, watchtower feeds).
- Deferred transactions: pvm_host.create_deferred_tx('handler', payload) schedules a self-call for the next block - the actor equivalent of "send myself a message".
- Timers (CIP-1): pvm_host.schedule_timer(target_block_height, payload) runs a handler at a specific future block, natively at the protocol level (no keeper bots).

The Erlang mapping: processes->actors, mailboxes->actor mailboxes, message passing (!)->send_message, reductions->cycles, gen_server->actor base pattern, supervisors->validator/protocol-level restart, applications->deployed actor collections.`,
  },
  {
    id: "runners",
    title: "Runners: off-chain compute",
    keywords: ["runner", "runners", "llm", "http", "mcp", "job", "jobs", "inference", "ai", "off-chain", "offchain", "continuation", "async", "await", "verify"],
    body: `Runners are staked off-chain compute nodes that execute jobs actors can't run on-chain: LLM inference, HTTP requests, MCP tools, agent loops. Results return to the chain via callbacks with optional multi-runner verification (consensus thresholds, TEE attestation fields exist in the job spec).

From actor code (requires @runner.continuation on an async handler):
  result = await runner.llm(prompt, system_prompt=..., max_tokens=256, temperature=0.7)
  result = await runner.http(url, method='GET', headers={}, body=None)
Use ctx = capture() before the await and read attributes after to persist locals across the suspension.

Runner registration/stake: /runner register --stake <amount>; discovery via GET /runners/active (rate cards: per-token LLM pricing, http base price, compute/memory rates; capabilities: job_types, regions, max_concurrent_jobs).

Job lifecycle: submit (job spec tx) -> assigned runner(s) execute -> results posted -> optional verified consensus. Inspect with /job status|results|verified|runners --job-id <id>. The job id is sha256(tx_hash || block_height_be8).`,
  },
  {
    id: "tokens",
    title: "CIP-20 tokens",
    keywords: ["token", "tokens", "cip-20", "cip20", "erc-20", "erc20", "mint", "burn", "supply", "symbol", "launch", "moola"],
    body: `CIP-20 is Cowboy's native fungible token standard (ERC-20 analog), implemented at the protocol level rather than per-contract.

From actor code:
  token_id = runtime.token_create(name, symbol, decimals, initial_supply)
  runtime.token_transfer(token_id, to_addr, amount)
  balance = runtime.token_balance_of(token_id, addr)
  runtime.token_mint(token_id, to_addr, amount)   # owner only
  runtime.token_burn(token_id, amount)            # owner only

From lasso: /token launch (interactive wizard), /token create --name <n> --symbol <s> --initial-supply <n> [--decimals <d>] [--max-supply <m>], plus transfer/approve/mint/burn/info/balance/list. Token amounts respect the token's own decimals; CBY itself has 9.`,
  },
  {
    id: "watchtower",
    title: "Watchtower feeds",
    keywords: ["watchtower", "feed", "feeds", "publish", "subscribe", "subscriber", "stream", "pubsub", "pub-sub", "notify"],
    body: `Watchtower is Cowboy's on-chain pub/sub: named feeds that actors and clients publish to, with subscribers receiving entries.

From lasso:
  /watchtower new feed --name <n> [--description <d>]
  /watchtower feed <id> publish --data <json>
  /watchtower feed <id> subscribers
  /watchtower feeds          (list feeds)
  /watchtower list           (list watchtower resources)

A registry address per network ties feeds together; /init writes the well-known registry for mesa into .cowboy/config.json. Typical pattern: an actor emits events, a watchtower feed fans them out, off-chain subscribers (bots, UIs) react.`,
  },
  {
    id: "deploy",
    title: "Deploy and actor lifecycle",
    keywords: ["deploy", "deployment", "lifecycle", "execute", "logs", "upgrade", "address", "salt", "scaffold", "new", "ship"],
    body: `Lifecycle of an actor, lasso commands in order:
1. /actor new <name> - scaffold actors/<name>/main.py
2. (optional) cowboy dev - run a handler locally against the simulated PVM before deploying
3. /actor deploy actors/<name>/main.py - deploys with a random salt and 10M/10M gas limits; lasso records the actor address and labels it from the file path
4. /actor execute <address> <handler> [--payload <json-hex>] - invoke a handler (defaults: payload 0x7b7d i.e. '{}', 500k/500k limits)
5. /actor get <address> - balance, nonce, code hash, mailbox depth, storage keys
6. /actor logs <address> - execution logs
7. /actor list - actors deployed from this console (live data when dashboard_url is set)

Deploy is CREATE2-style: address = f(code, creator, salt), via /actor address --code <f> --creator <c> --salt <s>. Actors carry CBY balances and pay their own gas for timer/deferred executions, so fund long-running actors.`,
  },
  {
    id: "ai-builder",
    title: "Lasso AI actor builder",
    keywords: ["builder", "generate", "prompt", "vllm", "model", "refactor", "assistant", "chat", "build"],
    body: `Plain (non-slash) text in lasso goes to the AI actor builder: it streams from a runner's OpenAI-compatible vLLM endpoint (runner_url in .cowboy/config.json), maintains multi-turn history (cleared by /clear), writes generated actors to actors/<name>/main.py, and suggests the deploy command.

The builder grounds its answers in this bundled knowledge pack (retrieved per prompt) and can read local actor files you mention by path (e.g. "refactor actors/hello/main.py to add a reset handler").

Routing preferences: /runner primary <addr|auto> and /runner helper <addr|auto>; short prompts route to the helper when smallPromptRouting is enabled.`,
  },
];
