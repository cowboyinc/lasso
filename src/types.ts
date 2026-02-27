export interface SessionState {
  privateKey: string | null;
  validatorUrl: string;
}

export interface LassoConfig {
  validatorUrl: string;
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
  | { type: "init" }
  | { type: "execute"; command: string; args: string[] };
