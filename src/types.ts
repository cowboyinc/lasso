export interface ActorEntry {
  address: string;
  label: string;
}

export interface FeedEntry {
  id: string;
  name?: string;
}

export interface ProjectConfig {
  validatorUrl: string;
  dashboardUrl: string | null;
  walletAddress: string | null;
  actors: ActorEntry[];
  feeds: FeedEntry[];
}

export interface SessionState {
  validatorUrl: string;
  dashboardUrl: string | null;
  walletAddress: string | null;
  actors: ActorEntry[];
  feeds: FeedEntry[];
}

export interface ConsoleMessage {
  role: "command" | "output" | "error" | "system";
  content: string;
}

export interface EditorBuffer {
  value: string;
  cursorOffset: number;
}

export interface SuggestionMenu {
  isOpen: true;
  tokenStart: number;
  tokenEnd: number;
  query: string;
  candidates: import("./commands/autocomplete.js").CompletionItem[];
  activeIndex: number;
}

export interface LineEditorProps extends EditorBuffer {
  onChange: (buffer: EditorBuffer) => void;
  onSubmit: (value: string) => void;
  onInterrupt?: () => void;
  onCancel?: () => void;
  onAutocomplete?: () => void;
  onSuggestionNext?: () => void;
  onSuggestionPrevious?: () => void;
  onSuggestionAccept?: () => void;
  onSuggestionDismiss?: () => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  onActivity?: () => void;
  placeholder?: string;
  mask?: string;
  isDisabled?: boolean;
  hasOpenSuggestions?: boolean;
}

export type CommandResult =
  | { type: "output"; text: string }
  | { type: "error"; text: string }
  | { type: "quit" }
  | { type: "clear" }
  | { type: "execute"; command: string; args: string[] }
  | { type: "wizard"; wizard: "token-launch" };
