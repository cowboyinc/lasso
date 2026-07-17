#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { App } from "./app.js";
import { loadProjectConfig, DEFAULT_DASHBOARD_URL } from "./config.js";
import { findProjectRoot } from "./project.js";
import { VERSION } from "./constants.js";
import type { ProjectConfig } from "./types.js";

const HELP_TEXT = `lasso ${VERSION} - interactive console for the Cowboy blockchain

Usage: lasso [options]

Options:
  -v, --version   Print version and exit
  -h, --help      Print this help and exit

Running lasso with no arguments starts the console. Inside it:
  /walkthrough    guided tour of how Cowboy works
  /init           create a project on mesa (the public devnet)
  /help           every command

Lasso connects to mesa by default. It works from the nearest project
(an ancestor .cowboy/ directory), or the current directory if there's
none — run /init to create one.`;

const DEFAULT_CONFIG: ProjectConfig = {
  validatorUrl: "https://rpc.mesa.cowboylabs.net",
  dashboardUrl: DEFAULT_DASHBOARD_URL,
  walletAddress: null,
  runnerUrl: null,
  actors: [],
  runnerPreferences: {
    primaryRunner: null,
    helperRunner: null,
    smallPromptRouting: true,
  },
};

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`lasso ${VERSION}`);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }
  if (args.length > 0) {
    console.error(`Unknown argument: ${args[0]}\n\n${HELP_TEXT}`);
    process.exitCode = 1;
    return;
  }

  // Resolve the project workspace by walking up for `.cowboy/` (COW-2459), then
  // work from there — so config, the sandbox, and the local FS tools are all
  // rooted at the project even when lasso is launched from a subdirectory.
  const launchDir = process.cwd();
  const { root: projectRoot, found } = findProjectRoot(launchDir);
  if (found && projectRoot !== launchDir) {
    process.chdir(projectRoot);
  }
  const movedIntoProject = found && projectRoot !== launchDir;

  const config = loadProjectConfig();
  const hasProject = config !== null && existsSync(join(process.cwd(), ".cowboy"));

  // Push cursor to bottom so the console starts at the bottom of the screen
  const padding = (process.stdout.rows || 24) - 4;
  if (padding > 0) {
    process.stdout.write("\n".repeat(padding));
  }

  render(
    <App
      initialConfig={config ?? DEFAULT_CONFIG}
      hasProject={hasProject}
      movedIntoProject={movedIntoProject}
    />,
    { exitOnCtrlC: false }
  );
}

main();
