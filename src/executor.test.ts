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

test("interrupted commands do not report later stdout as a successful completion", async () => {
  const command = startCommand(process.execPath, [
    "-e",
    "process.on('SIGINT', () => { setTimeout(() => process.stdout.write('late output'), 50); setTimeout(() => process.exit(0), 100); }); setInterval(() => {}, 1000);",
  ]);

  await delay(100);
  command.cancel();

  const result = await command.promise;

  assert.equal(result.status, "interrupted");
  assert.equal(result.output.includes("late output"), false);
});
