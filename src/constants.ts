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
  "  /help for commands, or describe what you want to build",
  "  /actor deploy <file>  /runner list  /token launch",
  "  /exit to quit",
  "",
].join("\n");
