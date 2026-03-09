export interface ProjectConfig {
  validatorUrl: string;
  walletAddress: string | null;
  actors: string[];
}

export interface SessionState {
  validatorUrl: string;
  walletAddress: string | null;
  actors: string[];
}

export interface ConsoleMessage {
  role: "command" | "output" | "error" | "system";
  content: string;
}

export type CommandResult =
  | { type: "output"; text: string }
  | { type: "error"; text: string }
  | { type: "quit" }
  | { type: "clear" }
  | { type: "execute"; command: string; args: string[] };
