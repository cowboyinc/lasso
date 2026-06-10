/**
 * /walkthrough - a guided tour of how Cowboy works.
 *
 * Modeled on cowboy/examples/erlangcowboydemo: short numbered lessons,
 * each with a concrete code or command block, ending with the
 * Erlang -> Cowboy lineage and the real command sequence to ship an
 * actor. Content sourced from the bundled knowledge pack.
 */

export interface WalkthroughLesson {
  title: string;
  body: string;
}

export const WALKTHROUGH_LESSONS: WalkthroughLesson[] = [
  {
    title: "What is Cowboy?",
    body: `Cowboy is a Layer 1 blockchain built for autonomous agents.

Two ideas define it:

  1. Smart contracts are Python.  "Actors" run in a deterministic
     Python VM (the PVM) - no Solidity, no new language to learn.

  2. Agents need more than a ledger.  The protocol natively includes
     timers (self-scheduling code), runners (verifiable off-chain
     LLM / HTTP compute), and CBFS (encrypted file storage).

You are connected to mesa, the public devnet, by default. Everything
in this walkthrough can be tried right now, for free.`,
  },
  {
    title: "Wallets and CBY",
    body: `CBY is the native token. It has 9 decimals (1 CBY = 10^9 wei).

When you ran /init, lasso:
  - generated a secp256k1 keypair into .cowboy/keys/<network>
  - derived your 0x... address from it
  - asked the devnet faucet to fund it (5,000 CBY per drip)

Lasso also tops you up automatically: if your wallet balance is 0 at
launch, it requests a faucet drip for you.

  Try:
    /wallet address
    /wallet balance
    /faucet              (manual top-up, any time)`,
  },
  {
    title: "Actors: Python smart contracts",
    body: `An actor is a Python class. init() runs at deploy; every other
method is a handler you can call from the outside.

    from cowboy_sdk import actor, runtime

    @actor
    class Counter:
        def init(self, payload):
            runtime.charge_gas(500)
            self.storage['count'] = 0
            return b'ok'

        def increment(self, payload):
            runtime.charge_gas(200)
            self.storage['count'] = self.storage.get('count', 0) + 1
            return str(self.storage['count']).encode()

Handlers take payload (bytes) and return bytes. Gas is charged
explicitly. The PVM is deterministic: no clock, no randomness, no
network - use block height for time, runners for the outside world.`,
  },
  {
    title: "Storage: the one rule",
    body: `Each actor has a private key-value store: self.storage. Values
are CBOR-encoded automatically. One rule matters:

  In-place mutation does NOT persist.

    # WRONG - silently lost:
    self.storage['items'].append(x)

    # RIGHT - read, modify, write back:
    items = self.storage.get('items', [])
    items.append(x)
    self.storage['items'] = items

  # For unbounded data, index keys instead of growing one list:
    count = self.storage.get('n', 0)
    self.storage[f'msg:{count}'] = data
    self.storage['n'] = count + 1

Storage is metered (see next lesson), so write only what changed.`,
  },
  {
    title: "Gas: Cycles and Cells",
    body: `Cowboy meters gas on two independent axes:

  Cycles  - compute: bytecode instructions executed
  Cells   - data: storage bytes written and held

Each has its own basefee, so a compute-heavy AI actor and a
data-heavy archive actor don't bid against each other for the same
resource. (Erlang folks: Cycles are reductions with a price tag.)

Every transaction carries limits for both. Lasso defaults:
  /actor execute ...   500k cycles / 500k cells
  /actor deploy  ...   10M  cycles / 10M  cells

In actor code you charge explicitly: runtime.charge_gas(200) for a
simple handler, more for heavy work. Blowing a limit aborts the tx.`,
  },
  {
    title: "Messages, mailboxes, timers",
    body: `Actors never share memory - they pass messages, like Erlang
processes. Each actor has a mailbox; sends are asynchronous.

    runtime.send_message(target, payload)     # actor -> actor
    runtime.emit_event('topic', {...})        # actor -> the world
    pvm_host.create_deferred_tx('h', payload) # actor -> itself, next block
    pvm_host.schedule_timer(height, payload)  # actor -> itself, later

That last one is rare among blockchains: protocol-native timers.
A liquidation bot, a recurring payment, a cron job - all on-chain,
no external keeper required.

The lineage, explicitly:
  Erlang processes -> actors          mailboxes  -> actor mailboxes
  message passing  -> send_message    reductions -> cycles
  gen_server       -> actor pattern   supervisors-> protocol restart`,
  },
  {
    title: "Runners: LLMs and the outside world",
    body: `On-chain code can't call APIs or run inference. Runners can:
staked off-chain nodes that execute LLM / HTTP / MCP jobs and post
results back, optionally verified across multiple runners.

    from cowboy_sdk import actor, runner, capture, runtime

    @actor
    class Oracle:
        @runner.continuation
        async def ask(self, payload):
            runtime.charge_gas(2000)
            ctx = capture()                  # save locals across await
            result = await runner.llm('Summarize: ...', max_tokens=256)
            self.storage['answer'] = str(result)
            return b'ok'

  Try:
    /runner list           (who's serving, models, prices)
    /job status --job-id <id>

Plain text in lasso (no slash) talks to the AI actor builder, which
streams from a runner and writes generated actors to actors/.`,
  },
  {
    title: "Tokens and feeds",
    body: `Two protocol-level primitives you get for free:

CIP-20 tokens - fungible tokens without deploying a token contract:
    runtime.token_create(name, symbol, decimals, supply)
    runtime.token_transfer(token_id, to, amount)

  Try:  /token launch        (interactive wizard)
        /token list

Watchtower feeds - on-chain pub/sub for events:
    /watchtower new feed --name prices
    /watchtower feed <id> publish --data '{"btc": 97000}'
    /watchtower feeds

Typical shape: an actor emits events, a feed fans them out, bots and
UIs subscribe off-chain.`,
  },
  {
    title: "Ship something",
    body: `The full loop, end to end:

    /init                       # mesa project + funded wallet (done?)
    /actor new myactor          # scaffold actors/myactor/main.py
    /actor deploy actors/myactor/main.py
    /actor execute <address> <handler>
    /actor get <address>        # state, balance, mailbox
    /actor logs <address>       # execution logs
    /actor list                 # everything you've deployed

Or skip the scaffold: describe what you want in plain text
("build me an escrow actor with a timeout refund") and the AI
builder writes it; deploy with one command.

Going deeper:
    /docs                       # bundled reference topics
    /help                       # every command

That's the tour. Welcome to Cowboy.`,
  },
];
