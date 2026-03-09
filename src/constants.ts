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
  "  Type init to set your private key",
  "  Type deploy actor <file> to deploy an actor",
  "  Type help for all commands",
  "  Type exit to quit",
  "",
  "",
].join("\n");
