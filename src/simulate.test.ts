import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSimulateArgs,
  parseSimulateOutput,
  redactAbsolutePaths,
  buildSimulateArgv,
  runLocalSimulate,
  type SimulateArgs,
} from "./simulate.js";

// ── validation ───────────────────────────────────────────────────────────────

test("validate: accepts a well-formed path-based request", () => {
  assert.doesNotThrow(() =>
    validateSimulateArgs({ actorPath: "actors/x/main.py", handler: "get", payload: "0x7b7d" })
  );
});

test("validate: accepts inline code and dotted handlers", () => {
  assert.doesNotThrow(() => validateSimulateArgs({ code: "print(1)", handler: "Counter.get" }));
});

test("validate: requires exactly one of actorPath / code", () => {
  assert.throws(() => validateSimulateArgs({ handler: "get" }), /exactly one/);
  assert.throws(
    () => validateSimulateArgs({ actorPath: "a.py", code: "x", handler: "get" }),
    /exactly one/
  );
});

test("validate: rejects a handler that could be read as a flag or is not an identifier", () => {
  for (const bad of ["-rf", "--actor", "a b", "1abc", "a;b", ""]) {
    assert.throws(
      () => validateSimulateArgs({ code: "x", handler: bad }),
      /handler/,
      `handler=${JSON.stringify(bad)}`
    );
  }
});

test("validate: rejects non-hex or oversized payload and out-of-range limits", () => {
  assert.throws(() => validateSimulateArgs({ code: "x", handler: "get", payload: "zz" }), /payload/);
  assert.throws(
    () => validateSimulateArgs({ code: "x", handler: "get", cyclesLimit: 0 }),
    /cyclesLimit/
  );
  assert.throws(
    () => validateSimulateArgs({ code: "x", handler: "get", cellsLimit: 2 ** 40 }),
    /cellsLimit/
  );
});

// ── argv (no injection surface) ──────────────────────────────────────────────

test("buildSimulateArgv: fixed --flag value shape, defaults applied, no positionals", () => {
  const argv = buildSimulateArgv("/tmp/actor.py", { actorPath: "x", handler: "get" });
  assert.equal(argv[0], "dev");
  assert.ok(argv.includes("--actor") && argv.includes("/tmp/actor.py"));
  assert.ok(argv.includes("--handler") && argv.includes("get"));
  assert.ok(argv.includes("--cycles-limit") && argv.includes("--cells-limit"));
  assert.ok(argv.includes("--json"));
  // handler is validated elsewhere; it only ever appears as a --handler value.
  assert.equal(argv.indexOf("get"), argv.indexOf("--handler") + 1);
});

// ── parsing (assumed cowboy dev JSON contract) ───────────────────────────────

test("parse: an ok JSON result maps fields and is advisory/local", () => {
  const r = parseSimulateOutput('{"status":"ok","cycles_used":1200,"cells_used":8}', 0);
  assert.equal(r.status, "ok");
  assert.equal(r.cyclesUsed, 1200);
  assert.equal(r.cellsUsed, 8);
  assert.equal(r.advisory, true);
  assert.equal(r.simulator, "local");
});

test("parse: an error JSON result surfaces the error even on exit 0", () => {
  const r = parseSimulateOutput('{"error":"handler raised ValueError"}', 0);
  assert.equal(r.status, "error");
  assert.match(r.error ?? "", /ValueError/);
});

test("parse: warning lines before the JSON are tolerated", () => {
  const r = parseSimulateOutput('WARN loading\n{"status":"ok","cycles_used":1}', 0);
  assert.equal(r.status, "ok");
  assert.equal(r.cyclesUsed, 1);
});

test("parse: missing JSON is an error even on exit 0 (never a false pass)", () => {
  const nonzero = parseSimulateOutput("boom: something failed", 1);
  assert.equal(nonzero.status, "error");
  assert.ok(nonzero.logs);
  // `--json` ignored by an old CLI but exit 0 → still a failure, not a pass.
  const exit0 = parseSimulateOutput("Simulation OK (human-readable, no json)", 0);
  assert.equal(exit0.status, "error");
  assert.match(exit0.error ?? "", /no JSON result/);
});

test("parse: an explicit non-ok status overrides an exit-0 fallback (not a false pass)", () => {
  const r = parseSimulateOutput('{"status":"error","logs":"trap"}', 0);
  assert.equal(r.status, "error");
  const f = parseSimulateOutput('{"ok":false}', 0);
  assert.equal(f.status, "error");
});

test("parse: a non-zero exit is never a pass, even with an OK JSON line (truncation)", () => {
  const r = parseSimulateOutput('{"status":"ok","cycles_used":10}', 1);
  assert.equal(r.status, "error");
});

test("parse: JSON without recognized simulate fields is not a pass", () => {
  const r = parseSimulateOutput('{"foo":"bar"}', 0);
  assert.equal(r.status, "error");
  assert.match(r.error ?? "", /unexpected simulator output/);
});

test("parse: only the FINAL line is authoritative — a mid-run printed JSON can't spoof", () => {
  // The simulated actor prints a fake ok-result, then the CLI emits the real
  // (error) result as the final line: the fake line must never win.
  const spoofed = parseSimulateOutput(
    '{"status":"ok","cycles_used":1}\n{"status":"error","error":"handler raised"}',
    0
  );
  assert.equal(spoofed.status, "error");
  // And a fake JSON buried before non-JSON CLI text is not consulted at all.
  const buried = parseSimulateOutput('{"status":"ok","cycles_used":1}\nsimulation crashed', 1);
  assert.equal(buried.status, "error");
  assert.match(buried.error ?? "", /no JSON result/);
});

test("validate: code cap counts bytes, not UTF-16 units", () => {
  // 3-byte chars: under the cap in code units, over it in bytes.
  const multibyte = "€".repeat(200 * 1024); // 200Ki chars ≈ 600 KiB > 512 KiB cap
  assert.throws(
    () => validateSimulateArgs({ code: multibyte, handler: "get" }),
    /code exceeds/
  );
});

// ── redaction ────────────────────────────────────────────────────────────────

test("redact: temp dir, project root and home are stripped from surfaced text", () => {
  const out = redactAbsolutePaths(
    "error at /var/folders/ab/lasso-sim-XX/actor.py, /Users/me/proj/x.py, /Users/me/.ssh/id",
    [
      ["/var/folders/ab/lasso-sim-XX", "<tmp>"],
      ["/Users/me/proj", "."],
      ["/Users/me", "~"],
    ]
  );
  assert.ok(!out.includes("/var/folders/ab/lasso-sim-XX"), "temp redacted");
  assert.ok(!out.includes("/Users/me/proj"), "project root redacted");
  assert.ok(!out.includes("/Users/me/.ssh"), "home redacted");
});

// ── runner: sandbox rejection happens before any spawn ───────────────────────

test("runLocalSimulate: an out-of-project actorPath is rejected as invalid_args (no spawn)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lasso-simroot-")));
  try {
    const args: SimulateArgs = { actorPath: "../../etc/passwd", handler: "get" };
    const res = await runLocalSimulate(args, { root });
    assert.equal(res.status, "error");
    if (res.status === "error") assert.equal(res.errorCode, "invalid_args");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
