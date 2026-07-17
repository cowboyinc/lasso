import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "./project.js";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "lasso-proj-")));
}

test("findProjectRoot: returns the dir that holds .cowboy", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".cowboy"));
    const r = findProjectRoot(root);
    assert.equal(r.found, true);
    assert.equal(r.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectRoot: walks UP from a subdirectory to the project root", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".cowboy"));
    const deep = join(root, "actors", "counter", "nested");
    mkdirSync(deep, { recursive: true });
    const r = findProjectRoot(deep);
    assert.equal(r.found, true);
    assert.equal(r.root, root, "resolves to the ancestor holding .cowboy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectRoot: no project → returns the start dir, found=false", () => {
  const root = scratch();
  try {
    const r = findProjectRoot(root);
    assert.equal(r.found, false);
    assert.equal(r.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectRoot: a `.cowboy` FILE (not a directory) is not a project", () => {
  const root = scratch();
  try {
    writeFileSync(join(root, ".cowboy"), "not a dir");
    const r = findProjectRoot(root);
    assert.equal(r.found, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectRoot: picks the NEAREST project when nested", () => {
  const outer = scratch();
  try {
    mkdirSync(join(outer, ".cowboy"));
    const inner = join(outer, "sub", "proj");
    mkdirSync(inner, { recursive: true });
    mkdirSync(join(inner, ".cowboy"));
    const r = findProjectRoot(join(inner, "actors"));
    assert.equal(r.root, inner, "nearest ancestor wins");
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
