import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_SPECS, findCommandSpec, renderHelpText } from "./schema.js";

test("command specs expose parser-backed routes", () => {
  const spec = findCommandSpec(["actor", "deploy"]);

  assert.ok(spec);
  assert.equal(spec?.parserKey, "actor-deploy");
  assert.equal(spec?.usage, "actor deploy <file.py>");
});

test("help text is generated from the command schema", () => {
  const helpText = renderHelpText(COMMAND_SPECS);

  assert.match(helpText, /actor deploy <file\.py>/);
  assert.match(helpText, /watchtower feed <id> publish --data <json>/);
  assert.doesNotMatch(helpText, /Commands:\n\nCommands:/);
});

