/**
 * Permission policy for local actions (COW-2463).
 *
 * lasso runs on the user's machine with their wallet, so every sensitive local
 * action (write / exec / deploy / sign) the AGENT asks lasso to perform must
 * pass an approval gate before it runs. Scope: this governs agent-initiated
 * tool actions routed through the gate — a slash command the user types (e.g.
 * `/actor deploy`) is their own direct intent and runs as typed, like any CLI.
 * An agent that wants to deploy must get its tx signed, which always asks.
 * This module is the single, pure, exhaustively-tested decision point:
 * `decide(permission, mode)` says whether an action is auto-allowed, needs an
 * interactive prompt, or is refused outright. The UI gate (app.tsx) enforces
 * the decision; it must never re-derive policy inline.
 */

/** What a local tool does, from least to most dangerous. Required on every
 *  registered tool — an unclassified action is denied.
 *
 *  `simulate` (COW-2461) is cheap, sandboxed local compute: it runs actor code
 *  in the deterministic no-I/O PVM via the `cowboy` CLI — no chain writes, no
 *  funds, no filesystem/network side effects. It sits between `read` and `exec`:
 *  safe to auto-run in `auto` mode, but worth a confirmation in `default` (it
 *  still spawns a process and consumes resources), so it rides the same
 *  auto-approval path as `write`. */
export type PermissionClass =
  | "read"
  | "write"
  | "exec"
  | "deploy"
  | "sign"
  | "simulate"
  | "secret";

/** `default`: auto-approve reads, ask for everything else. `auto`: opt-in, may
 *  additionally auto-approve the classes in AUTO_APPROVED_CLASSES (none yet).
 *  Session-only — never persisted, so a repo/tool can't leave the client in
 *  auto for a later session. */
export type PermissionMode = "default" | "auto";

/** `allow`: run without prompting. `ask`: show the approval prompt. `deny`:
 *  refuse outright (fail closed) — used for unknown/unclassified actions. */
export type PermissionDecision = "allow" | "ask" | "deny";

import type { WriteScope } from "./path-sandbox.js";

const KNOWN_CLASSES: readonly string[] = [
  "read",
  "write",
  "exec",
  "deploy",
  "sign",
  "simulate",
  "secret",
];

/**
 * Classes `auto` mode may auto-approve beyond what `default` does.
 *  - `write` (COW-2464) — but ONLY for in-project, non-protected targets: the
 *    scope check lives in the gate (`decideWrite`), not here, because a path is
 *    not a policy input.
 *  - `simulate` (COW-2461) — sandboxed local PVM compute with no chain/FS/network
 *    side effects; the tool itself enforces the bounds (timeout, output caps) and
 *    sandboxes any source path, so it is safe to auto-run.
 * `exec` stays out (no exec sandbox), and sign/deploy are irreversible /
 * fund-spending so they are always interactive regardless.
 */
const AUTO_APPROVED_CLASSES: readonly PermissionClass[] = ["write", "simulate"];

/**
 * Decide how an action of `permission` class is handled under `mode`.
 *
 * Invariants (do NOT weaken):
 *  - Unknown / unclassified permission → `deny` (fail closed), never `ask`: an
 *    attacker-framed prompt for an unknown action must not reach the user.
 *  - `sign` and `deploy` → `ask` ALWAYS, in every mode. Checked before the auto
 *    path, so no mode/config/list can auto-approve a fund-spending or on-chain
 *    action.
 *  - `read` → `allow`. NOTE: read results flow to the hosted backend, so read
 *    tools MUST be path-scoped when they land (COW-2458/2464); this policy
 *    assumes that scoping, it does not provide it.
 *  - `write` / `exec` → `ask`, unless `mode` is `auto` AND the class is in
 *    AUTO_APPROVED_CLASSES (empty today → they always ask for now).
 */
export function decide(permission: string, mode: PermissionMode): PermissionDecision {
  if (!KNOWN_CLASSES.includes(permission)) return "deny";
  const cls = permission as PermissionClass;

  // Hard invariant first: irreversible / fund-spending actions are always
  // interactive, before any auto-mode relaxation can apply.
  if (cls === "sign" || cls === "deploy") return "ask";

  if (cls === "read") return "allow";

  // `secret` (COW-2469) is interactive BY CONSTRUCTION: a secret-class tool's
  // only effect is showing the local masked capture prompt, which is itself
  // the consent step (cancel = the tool is cancelled; the value never appears
  // in args or results — see secret-tools.ts). Routing it through the y/n
  // gate would stack a second prompt in front of the first, so the gate
  // allows and the tool's own prompt does the asking, in every mode.
  if (cls === "secret") return "allow";

  // write / exec
  if (mode === "auto" && AUTO_APPROVED_CLASSES.includes(cls)) return "allow";
  return "ask";
}

/**
 * Decide a WRITE whose target has been classified by the path sandbox
 * (COW-2464). Composes the sandbox scope with the pure class policy so `decide`
 * stays path-agnostic:
 *  - `invalid` (traversal / symlink escape / malformed) → `deny`, never a prompt.
 *  - `outside` (a well-formed path outside the project) → `deny`. The agent has
 *    no business writing outside the user's project, and canonicalizing an
 *    external target for a safe prompt is a rabbit hole (system dirs like macOS
 *    `/tmp` are themselves symlinks), so agent writes are confined to the project.
 *  - `protected` (sensitive in-project file) → the `auto` relaxation is dropped
 *    (effective mode `default`), so it always `ask`s — never written silently.
 *  - `inside` → the normal `decide("write", mode)`: `allow` in auto, `ask` in
 *    default.
 */
export function decideWrite(scope: WriteScope, mode: PermissionMode): PermissionDecision {
  if (scope === "invalid" || scope === "outside") return "deny";
  const effectiveMode: PermissionMode = scope === "inside" ? mode : "default";
  return decide("write", effectiveMode);
}
