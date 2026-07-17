import test from "node:test";
import assert from "node:assert/strict";
import { decide, decideWrite, type PermissionMode, type PermissionDecision } from "./permissions.js";

const MODES: PermissionMode[] = ["default", "auto"];

test("read is allowed in every mode", () => {
  for (const mode of MODES) assert.equal(decide("read", mode), "allow");
});

test("sign and deploy ALWAYS ask — even in auto (hard invariant)", () => {
  for (const mode of MODES) {
    assert.equal(decide("sign", mode), "ask", `sign/${mode}`);
    assert.equal(decide("deploy", mode), "ask", `deploy/${mode}`);
  }
});

test("write is auto-approved in auto (sandbox landed); exec still asks everywhere", () => {
  assert.equal(decide("write", "default"), "ask", "write/default");
  assert.equal(decide("write", "auto"), "allow", "write/auto");
  for (const mode of MODES) {
    assert.equal(decide("exec", mode), "ask", `exec/${mode}`);
  }
});

test("unknown / unclassified / malformed → deny (fail closed), never ask", () => {
  for (const mode of MODES) {
    for (const bad of ["", "READ", "Sign", "network", "delete", "admin", "*"]) {
      assert.equal(decide(bad, mode), "deny", `${bad}/${mode}`);
    }
  }
});

test("full policy matrix", () => {
  const expected: Record<string, Record<PermissionMode, PermissionDecision>> = {
    read: { default: "allow", auto: "allow" },
    write: { default: "ask", auto: "allow" },
    exec: { default: "ask", auto: "ask" },
    deploy: { default: "ask", auto: "ask" },
    sign: { default: "ask", auto: "ask" },
  };
  for (const [cls, byMode] of Object.entries(expected)) {
    for (const mode of MODES) {
      assert.equal(decide(cls, mode), byMode[mode], `${cls}/${mode}`);
    }
  }
});

test("auto relaxes only `write` at the class level; sign/deploy/exec still ask", () => {
  // `write` is the one class auto may auto-approve — and only for in-sandbox
  // targets, which decideWrite enforces. Everything sensitive stays interactive.
  for (const cls of ["exec", "deploy", "sign"]) {
    assert.equal(decide(cls, "auto"), "ask", cls);
  }
  assert.equal(decide("write", "auto"), "allow", "write class-level auto-approve");
});

// ── decideWrite: sandbox scope × mode (COW-2464) ─────────────────────────────

test("decideWrite: an in-project target follows the class policy (auto=allow, default=ask)", () => {
  assert.equal(decideWrite("inside", "auto"), "allow");
  assert.equal(decideWrite("inside", "default"), "ask");
});

test("decideWrite: outside/protected targets never auto-approve — always ask", () => {
  for (const mode of MODES) {
    assert.equal(decideWrite("outside", mode), "ask", `outside/${mode}`);
    assert.equal(decideWrite("protected", mode), "ask", `protected/${mode}`);
  }
});

test("decideWrite: an invalid (traversal / escape) target is denied in every mode", () => {
  for (const mode of MODES) {
    assert.equal(decideWrite("invalid", mode), "deny", `invalid/${mode}`);
  }
});
