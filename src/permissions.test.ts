import test from "node:test";
import assert from "node:assert/strict";
import { decide, type PermissionMode, type PermissionDecision } from "./permissions.js";

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

test("write and exec ask in every mode today (auto-approve deferred to sandbox)", () => {
  for (const mode of MODES) {
    assert.equal(decide("write", mode), "ask", `write/${mode}`);
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
    write: { default: "ask", auto: "ask" },
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

test("auto never auto-approves anything sensitive right now (auto === default in effect)", () => {
  // Until sandboxing lands, auto must not diverge from default for any class.
  for (const cls of ["read", "write", "exec", "deploy", "sign"]) {
    assert.equal(decide(cls, "auto"), decide(cls, "default"), cls);
  }
});
