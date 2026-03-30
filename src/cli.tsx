#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { App } from "./app.js";
import { loadProjectConfig } from "./config.js";

function main() {
  const config = loadProjectConfig();
  const hasProject = config !== null && existsSync(join(process.cwd(), ".cowboy"));

  // Push cursor to bottom so the console starts at the bottom of the screen
  const padding = (process.stdout.rows || 24) - 4;
  if (padding > 0) {
    process.stdout.write("\n".repeat(padding));
  }

  render(
    <App
      initialConfig={config ?? { validatorUrl: "http://localhost:4000", dashboardUrl: null, walletAddress: null, actors: [] }}
      hasProject={hasProject}
    />,
    { exitOnCtrlC: false }
  );
}

main();
