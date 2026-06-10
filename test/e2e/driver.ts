/**
 * PTY driver for lasso e2e smoke tests.
 *
 * Spawns the built CLI (dist/cli.js) inside a pseudo-terminal, types
 * keystrokes with human-ish pacing, and resolves when an expected
 * pattern appears (or rejects on timeout). Ink requires a real TTY for
 * raw-mode input, hence node-pty rather than child_process.
 *
 * Quirk encoded here: the slash-suggestion picker consumes Enter as
 * autocomplete while suggestions are visible, and whether they are
 * visible depends on render timing. A trailing space hides the picker
 * deterministically (input is processed in order), so submit() types
 * "command + space" and a single Enter always submits.
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

  // Ink degrades to final-frame-only rendering when it detects CI
  // (is-in-ci), which blanks dynamic regions like the status bar and the
  // walkthrough pager. The whole point of the PTY is interactive
  // rendering, so scrub CI markers from the child env.
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined) as [string, string][]
  );
  for (const key of Object.keys(env)) {
    if (key === "CI" || key === "CONTINUOUS_INTEGRATION" || key === "BUILD_NUMBER" || key === "RUN_ID" || key.startsWith("GITHUB_") || key.startsWith("CI_")) {
      delete env[key];
    }
  }

  let buffer = "";
  const pty = spawn(process.execPath, [CLI_PATH], {
    name: "xterm-256color",
    cols: 100,
    rows: 40,
    cwd,
    env: {
      ...env,
      PATH: `${pathPrefix}${process.env.PATH ?? ""}`,
      LASSO_NO_UPDATE_CHECK: "1",
      ...opts?.env,
    },
  });
  pty.onData((data) => {
    buffer += data;
  });

  const output = () => stripAnsi(buffer);

  const waitFor = async (pattern: RegExp, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(output())) return;
      await sleep(100);
    }
    throw new Error(
      `Timed out waiting for ${pattern}\n--- output ---\n${output().slice(-2000)}`
    );
  };

  const pollFor = async (predicate: () => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(100);
    }
    return false;
  };

  /** The live editor line is the last prompt-marker line on screen. */
  const lastPromptLine = () => {
    const lines = output().split("\n").filter((l) => l.includes("❯"));
    return lines[lines.length - 1] ?? "";
  };

  const submit = async (command: string) => {
    // PTY input can drop characters on loaded CI runners (observed:
    // "/walkthrough" arriving as "/wlkthrough"). Type, verify the live
    // editor echoes the exact text, and retype after Ctrl+U if not.
    for (let attempt = 0; ; attempt++) {
      for (const ch of command) {
        pty.write(ch);
        await sleep(30);
      }
      if (await pollFor(() => lastPromptLine().includes(command), 4000)) break;
      if (attempt >= 2) {
        throw new Error(
          `Could not type "${command}" intact after ${attempt + 1} attempts\n--- last prompt ---\n${lastPromptLine()}`
        );
      }
      pty.write("\x15"); // Ctrl+U clears the line for a clean retry
      await sleep(250);
    }
    // Trailing space hides the suggestion picker (input is processed in
    // order), so a single Enter always submits. parseCommand trims.
    pty.write(" ");
    await sleep(200);
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
