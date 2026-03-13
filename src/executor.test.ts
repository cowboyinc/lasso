import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startCommand } from "./executor.js";

test("canceling a running command resolves as interrupted", async () => {
  const command = startCommand(process.execPath, [
    "-e",
    "setTimeout(() => process.stdout.write('finished'), 5000)",
  ]);

  await delay(100);
  command.cancel();

  const result = await command.promise;

  assert.equal(result.status, "interrupted");
  assert.equal(result.output, "");
});

test("interrupt requests that exit normally remain completed and warn", async () => {
  const command = startCommand(process.execPath, [
    "-e",
    "process.on('SIGINT', () => { setTimeout(() => process.stdout.write('late output'), 50); setTimeout(() => process.exit(0), 100); }); setInterval(() => {}, 1000);",
  ]);

  await delay(100);
  command.cancel();

  const result = await command.promise;

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.includes("Interrupt requested, but the command exited normally"), true);
  assert.equal(result.output.includes("late output"), true);
});

test("cancel escalates when the child ignores interrupt signals", async () => {
  const command = startCommand(
    process.execPath,
    [
      "-e",
      "process.on('SIGINT', () => { process.stdout.write('sigint ignored\\n'); }); process.on('SIGTERM', () => { process.stdout.write('sigterm ignored\\n'); }); setInterval(() => {}, 1000);",
    ],
    { interruptTermMs: 20, interruptKillMs: 40 }
  );

  await delay(100);
  command.cancel();

  const result = await command.promise;

  assert.equal(result.status, "interrupted");
  assert.equal(result.exitCode, 137);
  assert.equal(result.output, "");
});
