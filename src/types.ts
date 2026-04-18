export interface ActorEntry {
  address: string;
  label: string;
}

export interface RunnerPreferences {
  primaryRunner: string | null;
  helperRunner: string | null;
  smallPromptRouting: boolean;
}

export interface ProjectConfig {
  validatorUrl: string;
  dashboardUrl: string | null;
  walletAddress: string | null;
  actors: ActorEntry[];
  runnerPreferences: RunnerPreferences;
}

export interface SessionState {
  validatorUrl: string;
  dashboardUrl: string | null;
  walletAddress: string | null;
  actors: ActorEntry[];
  runnerPreferences: RunnerPreferences;
}

export interface ConsoleMessage {
  role: "command" | "output" | "error" | "system";
  content: string;
}

export interface EditorBuffer {
  value: string;
  cursorOffset: number;
}

export interface LineEditorProps extends EditorBuffer {
  onChange: (buffer: EditorBuffer) => void;
  onSubmit: (value: string) => void;
  onInterrupt?: () => void;
  onCancel?: () => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  onActivity?: () => void;
  placeholder?: string;
  mask?: string;
  isDisabled?: boolean;
}

export type CommandResult =
  | { type: "output"; text: string }
  | { type: "error"; text: string }
  | { type: "quit" }
  | { type: "clear" }
  | { type: "prompt"; text: string }
  | { type: "execute"; command: string; args: string[] }
  | { type: "wizard"; wizard: "token-launch" };
