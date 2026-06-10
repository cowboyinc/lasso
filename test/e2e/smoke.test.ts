/**
 * E2E smoke tests: drive the built TUI through a PTY with a canned
 * cowboy CLI on PATH. These exist to catch the bug class where lasso
 * misreads CLI results (false success, wrong next-steps, swallowed
 * errors). Run via `npm run test:e2e` after `npm run build`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { launchLasso } from "./driver.js";

test("banner shows version, walkthrough note, and mesa default", async () => {
  const s = launchLasso();
  try {
    await s.waitFor(/Console v\d+\.\d+\.\d+/);
    await s.waitFor(/Run \/walkthrough for a tour/);
    await s.waitFor(/rpc\.mesa\.cowboylabs\.net/);
  } finally {
    s.close();
  }
});

test("/docs gas renders the bundled section without a project", async () => {
  const s = launchLasso();
  try {
    await s.waitFor(/Console v/);
    await s.submit("/docs gas");
    await s.waitFor(/Gas: Cycles and Cells/);
    await s.waitFor(/Cells: data/);
  } finally {
    s.close();
  }
});

test("/walkthrough pager opens, advances, and closes", async () => {
  const s = launchLasso();
  try {
    await s.waitFor(/Console v/);
    await s.submit("/walkthrough");
    await s.waitFor(/Lesson 1\/\d+: What is Cowboy\?/);
    s.press("\r");
    await s.waitFor(/Lesson 2\/\d+/);
    s.press("q");
    await s.waitFor(/Walkthrough closed/);
  } finally {
    s.close();
  }
});

test("/init succeeds via the CLI and suggests the real starter actor", async () => {
  const s = launchLasso();
  try {
    await s.waitFor(/Console v/);
    await s.submit("/init mesa");
    await s.waitFor(/Wallet address: 0x1111/);
    await s.waitFor(/actors\/counter\/main\.py/);
    assert.ok(!s.output().includes("actors/hello/main.py"));
  } finally {
    s.close();
  }
});

test("/init failure renders as an error without next-steps", async () => {
  const s = launchLasso({ env: { COWBOY_STUB_MODE: "fail" } });
  try {
    await s.waitFor(/Console v/);
    await s.submit("/init mesa");
    await s.waitFor(/stub-injected failure/);
    assert.ok(!s.output().includes("Next step deploy"));
  } finally {
    s.close();
  }
});

test("missing cowboy CLI yields the install hint, not a success tail", async () => {
  const s = launchLasso({ withStubCli: false, env: { PATH: "/usr/bin:/bin" } });
  try {
    await s.waitFor(/Console v/);
    await s.submit("/init mesa");
    await s.waitFor(/cowboy CLI not found/);
    await s.waitFor(/brew install cowboyinc\/lasso\/cowboy/);
    assert.ok(!s.output().includes("Next step deploy"));
  } finally {
    s.close();
  }
});

test("silent nonzero CLI exit reports failure, not fake success", async () => {
  // Init a project with the working stub first, in a shared cwd.
  const setup = launchLasso();
  let cwd: string;
  try {
    await setup.waitFor(/Console v/);
    await setup.submit("/init mesa");
    await setup.waitFor(/Wallet address: 0x1111/);
    cwd = setup.cwd;
  } finally {
    setup.close();
  }

  // Relaunch in the same project with a CLI that exits 1 silently.
  const s = launchLasso({ cwd, env: { COWBOY_STUB_MODE: "fail-silent" } });
  try {
    await s.waitFor(/Console v/);
    await s.submit("/wallet balance");
    await s.waitFor(/Command failed \(exit 1\)/);
    assert.ok(!s.output().includes("Command completed (no output)"));
  } finally {
    s.close();
  }
});
