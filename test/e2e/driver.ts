/**
 * PTY driver for lasso e2e smoke tests.
 *
 * Spawns the built CLI (dist/cli.js) inside a pseudo-terminal, types
 * keystrokes with human-ish pacing, and resolves when an expected
 * pattern appears (or rejects on timeout). Ink requires a real TTY for
 * raw-mode input, hence node-pty rather than child_process.
 *
 * Quirk encoded here: the slash-suggestion picker consumes the first
 * Enter as autocomplete when suggestions are visible, so commands are
 * submitted with a double Enter.
 */
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");
const STUB_DIR = join(REPO_ROOT, "test", "e2e", "fixtures");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stripAnsi = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[<>=]/g, "");

export interface LassoSession {
  pty: IPty;
  cwd: string;
  output: () => string;
  /** Resolve once `pattern` matches the ANSI-stripped output. */
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  /** Type a command and submit it (double Enter for the suggestion picker). */
  submit: (command: string) => Promise<void>;
  /** Press raw keys without Enter handling. */
  press: (keys: string) => void;
  close: () => void;
}

export function launchLasso(opts?: {
  env?: Record<string, string>;
  withStubCli?: boolean;
  cwd?: string;
}): LassoSession {
  const cwd = opts?.cwd ?? mkdtempSync(join(tmpdir(), "lasso-e2e-"));
  const pathPrefix = opts?.withStubCli === false ? "" : `${STUB_DIR}:`;

  let buffer = "";
  const pty = spawn(process.execPath, [CLI_PATH], {
    name: "xterm-256color",
    cols: 100,
    rows: 40,
    cwd,
    env: {
      ...process.env,
      PATH: `${pathPrefix}${process.env.PATH ?? ""}`,
      LASSO_NO_UPDATE_CHECK: "1",
      ...opts?.env,
    },
  });
  pty.onData((data) => {
    buffer += data;
  });

  const output = () => stripAnsi(buffer);

  const waitFor = async (pattern: RegExp, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(output())) return;
      await sleep(100);
    }
    throw new Error(
      `Timed out waiting for ${pattern}\n--- output ---\n${output().slice(-2000)}`
    );
  };

  const submit = async (command: string) => {
    for (const ch of command) {
      pty.write(ch);
      await sleep(15);
    }
    await sleep(300);
    pty.write("\r");
    await sleep(300);
    pty.write("\r");
  };

  return {
    pty,
    cwd,
    output,
    waitFor,
    submit,
    press: (keys: string) => pty.write(keys),
    close: () => {
      try {
        pty.kill();
      } catch {
        /* already dead */
      }
    },
  };
}
