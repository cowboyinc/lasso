import test from "node:test";
import assert from "node:assert/strict";
import { actorFromCode, extractActors } from "./actor-extractor.js";

const COUNTER_CODE = `from cowboy import actor

@actor
class CounterActor:
    def init(self, payload):
        self.storage["count"] = 0

    def increment(self, payload):
        self.storage["count"] += 1
        return str(self.storage["count"]).encode()
`;

test("actorFromCode derives snake_case path from the class name", () => {
  const actor = actorFromCode(COUNTER_CODE);
  assert.equal(actor.className, "CounterActor");
  assert.equal(actor.filePath, "actors/counter/main.py");
});

test("actorFromCode appends the module-level dispatch shim", () => {
  const actor = actorFromCode(COUNTER_CODE);
  assert.match(actor.code, /_actor = CounterActor\(\)/);
  assert.match(actor.code, /def increment\(payload\)/);
});

test("actorFromCode falls back to actors/actor/main.py without a class", () => {
  const actor = actorFromCode(`def init(payload):\n    return b"ok"\n`);
  assert.equal(actor.className, null);
  assert.equal(actor.filePath, "actors/actor/main.py");
});

test("extractActors still extracts fenced python blocks", () => {
  const text = "Here you go:\n```python\n" + COUNTER_CODE + "```\n";
  const actors = extractActors(text);
  assert.equal(actors.length, 1);
  assert.equal(actors[0].filePath, "actors/counter/main.py");
});
