import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, normalizeEndpointUrl } from "./config.js";

test("normalizeEndpointUrl adds http scheme when missing", () => {
  assert.equal(
    normalizeEndpointUrl("rpc-01.mesa.cowboylabs.net:4000"),
    "http://rpc-01.mesa.cowboylabs.net:4000"
  );
  assert.equal(
    normalizeEndpointUrl("https://rpc-01.mesa.cowboylabs.net:4000"),
    "https://rpc-01.mesa.cowboylabs.net:4000"
  );
});

test("loadProjectConfig supports network alias and normalizes rpc_url", () => {
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "lasso-config-"));

  try {
    mkdirSync(join(dir, ".cowboy"));
    writeFileSync(
      join(dir, ".cowboy", "config.json"),
      JSON.stringify({
        network: "mesa",
        environments: {
          mesa: {
            rpc_url: "rpc-01.mesa.cowboylabs.net:4000",
          },
        },
      }, null, 2)
    );

    process.chdir(dir);
    const config = loadProjectConfig();
    assert.ok(config);
    assert.equal(config.validatorUrl, "http://rpc-01.mesa.cowboylabs.net:4000");
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
