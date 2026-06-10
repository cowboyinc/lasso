import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, normalizeEndpointUrl, DEFAULT_DASHBOARD_URL } from "./config.js";

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

function withTempConfig(
  contents: Record<string, unknown>,
  fn: () => void
): void {
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "lasso-config-"));
  try {
    mkdirSync(join(dir, ".cowboy"));
    writeFileSync(
      join(dir, ".cowboy", "config.json"),
      JSON.stringify(contents, null, 2)
    );
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("DEFAULT_DASHBOARD_URL points at the mesa dashboard", () => {
  assert.equal(DEFAULT_DASHBOARD_URL, "https://dashboard.mesa.cowboylabs.net");
});

test("dashboard_url defaults to the mesa dashboard when absent", () => {
  withTempConfig({ rpc_url: "https://rpc.mesa.cowboylabs.net" }, () => {
    const config = loadProjectConfig();
    assert.ok(config);
    assert.equal(config.dashboardUrl, DEFAULT_DASHBOARD_URL);
  });
});

test("dashboard_url empty string opts out (direct-runner mode)", () => {
  withTempConfig(
    { rpc_url: "https://rpc.mesa.cowboylabs.net", dashboard_url: "" },
    () => {
      const config = loadProjectConfig();
      assert.ok(config);
      assert.equal(config.dashboardUrl, null);
    }
  );
});

test("dashboard_url JSON null opts out too", () => {
  withTempConfig(
    { rpc_url: "https://rpc.mesa.cowboylabs.net", dashboard_url: null },
    () => {
      const config = loadProjectConfig();
      assert.ok(config);
      assert.equal(config.dashboardUrl, null);
    }
  );
});

test("dashboard_url explicit value is normalized and used", () => {
  withTempConfig(
    { rpc_url: "https://rpc.mesa.cowboylabs.net", dashboard_url: "localhost:8000" },
    () => {
      const config = loadProjectConfig();
      assert.ok(config);
      assert.equal(config.dashboardUrl, "http://localhost:8000");
    }
  );
});

test("dashboard_url scheme-less non-loopback host defaults to https", () => {
  withTempConfig(
    { rpc_url: "https://rpc.mesa.cowboylabs.net", dashboard_url: "dashboard.example.com" },
    () => {
      const config = loadProjectConfig();
      assert.ok(config);
      assert.equal(config.dashboardUrl, "https://dashboard.example.com");
    }
  );
});

test("dashboard_url explicit http is honored (deliberate opt-in)", () => {
  withTempConfig(
    { rpc_url: "https://rpc.mesa.cowboylabs.net", dashboard_url: "http://10.0.0.5:8000" },
    () => {
      const config = loadProjectConfig();
      assert.ok(config);
      assert.equal(config.dashboardUrl, "http://10.0.0.5:8000");
    }
  );
});
