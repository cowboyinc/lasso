import pkg from "../package.json" with { type: "json" };
export const VERSION: string = pkg.version;

export const LOGO_TEXT = [
  "                                                  _  _",
  "                                                 | || | _",
  "                                                -| || || |",
  "  ####   ###  ##   ## #####   ###  ##  ##        | || || |-",
  " ##  ## ## ## ##   ## ##  ## ## ## ##  ##         \ \_ || |",
  " ##     ## ## ## # ## #####  ## ##  ####            |  _/",
  " ##  ## ## ## ## # ## ##  ## ## ##   ##            -| | \ ",
  "  ####   ###   ## ##  #####   ###   ##              |_|-",
  "",
  `  Console v${VERSION}`,
  "",
  "  New here? Run /walkthrough for a tour of how Cowboy works.",
  "",
  "  /help for commands, or describe what you want to build",
  "  /actor deploy <file>  /runner list  /token launch",
  "  /exit to quit",
  "",
].join("\n");
