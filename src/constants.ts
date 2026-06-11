import pkg from "../package.json" with { type: "json" };
export const VERSION: string = pkg.version;

// Banner 0: slant wordmark + lasso rope coil
const ROPE_BANNER = [
  "     __________ _       ______  ______  __          _____",
  "    / ____/ __ \\ |     / / __ )/ __ \\ \\/ /       .-'     '-.",
  "   / /   / / / / | /| / / __  / / / /\\  /       /           \\",
  "  / /___/ /_/ /| |/ |/ / /_/ / /_/ / / /        ;           ;",
  "  \\____/\\____/ |__/|__/_____/\\____/ /_/          \\         /",
  "                                                  '-._. .-'",
  "                                                      \\ \\",
  "                                                       \\ '---.",
];

// Banner 1: big wordmark wearing the hat
const HAT_BANNER = [
  "              .-~~~~~~~~~~~~~~~~~~~-.",
  "             (  ~ ~ ~ ~ ~ ~ ~ ~ ~ ~  )",
  "              |                     |",
  "     .--------'---------------------'--------.",
  "      '---..___________________________..---'",
  "    _____ ______          ______   ______     __",
  "   / ____/ __ \\ \\        / /  _ \\ / __ \\ \\   / /",
  "  | |   | |  | \\ \\  /\\  / /| |_) | |  | \\ \\_/ /",
  "  | |   | |  | |\\ \\/  \\/ / |  _ <| |  | |\\   /",
  "  | |___| |__| | \\  /\\  /  | |_) | |__| | | |",
  "   \\_____\\____/   \\/  \\/   |____/ \\____/  |_|",
];

// Banner 2: the original cactus, now properly dressed
const CACTUS_BANNER = [
  "                                              ______",
  "                                           .-'______'-.",
  "                                          '------------'",
  "    ____ _____        ______   _____   __    | || | _",
  "   / ___/ _ \\ \\      / / __ ) / _ \\ \\ / /   -| || || |",
  "  | |  | | | \\ \\ /\\ / /|  _ \\| | | \\ V /     | || || |-",
  "  | |__| |_| |\\ V  V / | |_) | |_| || |       \\ \\_ || |",
  "   \\____\\___/  \\_/\\_/  |____/ \\___/ |_|        |  _/",
  "                                              -| | \\",
  "                                               |_|-",
];

const FOOTER = [
  "",
  `  Console v${VERSION}`,
  "",
  "  New here? Run /walkthrough for a tour of how Cowboy works.",
  "",
  "  /help for commands, or describe what you want to build",
  "  /actor deploy <file>  /runner list  /token launch",
  "  /exit to quit",
  "",
];

export const BANNERS: string[] = [ROPE_BANNER, HAT_BANNER, CACTUS_BANNER].map(
  (art) => [...art, ...FOOTER].join("\n")
);

/**
 * Banner tasting menu: rotates per launch (seconds clock) so each start
 * shows a different one. Pin a specific banner with LASSO_BANNER=0|1|2.
 */
export function getLogoText(): string {
  const pinned = Number(process.env.LASSO_BANNER);
  const index =
    Number.isInteger(pinned) && pinned >= 0 && pinned < BANNERS.length
      ? pinned
      : Math.floor(Date.now() / 1000) % BANNERS.length;
  return BANNERS[index];
}
