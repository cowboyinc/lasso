import React, { useState, useCallback, useEffect, useRef } from "react";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Box, Static, useApp } from "ink";
import { Header } from "./components/Header.js";
import { Message } from "./components/Message.js";
import { ThinkingSpinner } from "./components/ThinkingSpinner.js";
import { InputArea } from "./components/InputArea.js";
import { StatusBar } from "./components/StatusBar.js";
import { parseCommand } from "./commands/index.js";
import {
  deployActor,
  executeCowboy,
  fetchAccountBalance,
  fetchActorDetail,
  detectWalletAddress,
  fetchActiveRunners,
  fetchRunnerDetail,
  fetchMyActors,
  getCowboyVersion,
  fetchJobStatus,
  fetchJobResults,
  fetchJobVerified,
  requestFaucet,
  submitLlmJob,
  waitForJobId,
  waitForLlmJobResult,
} from "./executor.js";
import type { ActorInfo, RunnerInfo } from "./executor.js";
import { loadProjectConfig, saveActors, saveRunnerPreferences } from "./config.js";
import { basename } from "node:path";
import { createEditorState, shouldExitOnInterrupt } from "./editor-state.js";
import { TokenLaunchWizard } from "./components/TokenLaunchWizard.js";
import type { ActorEntry, ProjectConfig, ConsoleMessage, SessionState, EditorBuffer, RunnerPreferences } from "./types.js";
import { streamChat, trimMessages, discoverModel } from "./llm-client.js";
import type { ChatMessage } from "./llm-client.js";
import { ACTOR_BUILDER_SYSTEM_PROMPT } from "./prompts/actor-builder.js";
import { extractActors } from "./actor-extractor.js";
import {
  createConversation,
  postSignCallback,
  postToolResult,
  postAnswerCallback,
  streamAgentChat,
} from "./agent-client.js";
import { runAgentTurn } from "./agent-turn.js";
import { signHashLocally, type EcdsaSignature } from "./signer.js";
import { ToolRegistry, makeSignTool, SIGN_TOOL_NAME, DEFAULT_TOOL_TIMEOUT_MS } from "./client-tool-bridge.js";
import {
  makeSimulateTool,
  SIMULATE_TOOL_NAME,
  type SimulateArgs,
  type SimulateResult,
} from "./simulate.js";
import { decide, decideWrite, type PermissionClass, type PermissionMode } from "./permissions.js";
import { classifyWritePath, type WriteScope } from "./path-sandbox.js";
import {
  collectLocalFileContext,
  docsIndex,
  getDocSection,
  renderKnowledgeContext,
  retrieveSections,
} from "./knowledge/index.js";
import { WalkthroughPager } from "./components/WalkthroughPager.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";
import { stripTerminalControl } from "./terminal-sanitize.js";
import { WALKTHROUGH_LESSONS } from "./walkthrough.js";
import { checkForUpdate } from "./update-check.js";
import { VERSION } from "./constants.js";

/** Strip ANSI escapes and control characters from untrusted strings. */
function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1F\x7F-\x9F]/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function shortAddr(addr: string): string {
  const hex = addr.startsWith("0x") ? addr : `0x${addr}`;
  return `${hex.slice(0, 6)}...${hex.slice(-4)}`;
}

function formatTokenList(raw: string): string {
  const cleaned = raw.replace(/^.*?(WARN|INFO).*$/gm, "").trim();

  try {
    const tokens = JSON.parse(cleaned);
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return "No tokens found.";
    }

    const formatNum = (v: string | number) => {
      const n = Number(v);
      return isNaN(n) ? String(v) : n.toLocaleString("en-US");
    };

    const shortId = (id: string) => {
      const hex = id.startsWith("0x") ? id : `0x${id}`;
      return `${hex.slice(0, 10)}...${hex.slice(-4)}`;
    };

    const hdr = [
      "Name".padEnd(20),
      "Symbol".padEnd(8),
      "Dec".padEnd(5),
      "Total Supply".padStart(16),
      "Max Supply".padStart(16),
      "Owner".padEnd(13),
      "Token ID".padEnd(16),
    ].join("  ");

    const sep = "-".repeat(hdr.length);

    const rows = tokens.map((t: Record<string, unknown>) => {
      const name = sanitize(String(t.name ?? "")).slice(0, 20).padEnd(20);
      const symbol = sanitize(String(t.symbol ?? "")).padEnd(8);
      const decimals = String(t.decimals ?? "").padEnd(5);
      const supply = formatNum(t.total_supply as string).padStart(16);
      const maxSupply = t.max_supply ? formatNum(t.max_supply as string).padStart(16) : "unlimited".padStart(16);
      const owner = shortAddr(sanitize(String(t.owner ?? ""))).padEnd(13);
      const tokenId = shortId(sanitize(String(t.token_id ?? ""))).padEnd(16);
      return [name, symbol, decimals, supply, maxSupply, owner, tokenId].join("  ");
    });

    return [
      `  Tokens on chain (${tokens.length})`,
      "",
      `  ${hdr}`,
      `  ${sep}`,
      ...rows.map((r) => `  ${r}`),
    ].join("\n");
  } catch {
    return cleaned;
  }
}

function formatActorList(actors: ActorInfo[], localActors: ActorEntry[]): string {
  if (actors.length === 0) {
    return "No actors found for this wallet.";
  }

  const labelMap = new Map<string, string>();
  for (const a of localActors) {
    labelMap.set(a.address.toLowerCase(), a.label);
  }

  const hdr = [
    "#".padEnd(4),
    "Label".padEnd(20),
    "Address".padEnd(44),
    "Balance".padStart(12),
    "Nonce".padStart(7),
    "Storage".padStart(9),
    "Deployed".padStart(10),
  ].join("  ");

  const sep = "-".repeat(hdr.length);

  const rows = actors.map((a, i) => {
    const fullAddr = a.address.startsWith("0x") ? a.address : `0x${a.address}`;
    const label = (labelMap.get(fullAddr.toLowerCase()) || labelMap.get(a.address.toLowerCase()) || "").slice(0, 20).padEnd(20);
    const num = String(i + 1).padEnd(4);
    const addr = fullAddr.padEnd(44);
    const balance = a.balance.toLocaleString("en-US").padStart(12);
    const nonce = String(a.nonce).padStart(7);
    const storage = (a.storage_size != null ? String(a.storage_size) : "-").padStart(9);
    const deployed = (a.deploy_height != null ? `#${a.deploy_height}` : "-").padStart(10);
    return [num, label, addr, balance, nonce, storage, deployed].join("  ");
  });

  return [
    `  My actors (${actors.length})`,
    "",
    `  ${hdr}`,
    `  ${sep}`,
    ...rows.map((r) => `  ${r}`),
  ].join("\n");
}

function formatLocalActorList(actors: ActorEntry[]): string {
  const hdr = [
    "#".padEnd(4),
    "Label".padEnd(20),
    "Address".padEnd(44),
  ].join("  ");

  const sep = "-".repeat(hdr.length);

  const rows = actors.map((a, i) => {
    const num = String(i + 1).padEnd(4);
    const label = (a.label || "").slice(0, 20).padEnd(20);
    const addr = a.address.padEnd(44);
    return [num, label, addr].join("  ");
  });

  return [
    `  My actors (${actors.length}) - local only`,
    "  Set dashboard_url in .cowboy/config.json for live data",
    "",
    `  ${hdr}`,
    `  ${sep}`,
    ...rows.map((r) => `  ${r}`),
  ].join("\n");
}

function formatSimulateResult(r: SimulateResult): string {
  const lines = [
    `  Local simulation (${r.status === "ok" ? "passed" : "failed"}) — advisory`,
    "",
  ];
  if (r.cyclesUsed != null) lines.push(`  Cycles: ${r.cyclesUsed.toLocaleString("en-US")}`);
  if (r.cellsUsed != null) lines.push(`  Cells:  ${r.cellsUsed.toLocaleString("en-US")}`);
  if (r.stateChanges != null) {
    lines.push("", "  State changes:", `    ${sanitize(JSON.stringify(r.stateChanges)).slice(0, 500)}`);
  }
  if (r.events != null) {
    lines.push("", "  Events:", `    ${sanitize(JSON.stringify(r.events)).slice(0, 500)}`);
  }
  if (r.logs) lines.push("", "  Logs:", `    ${sanitize(r.logs).slice(0, 1000)}`);
  if (r.error) lines.push("", `  Error: ${sanitize(r.error).slice(0, 500)}`);
  lines.push("", "  Local PVM result — not on-chain truth; deploy + verify to confirm.");
  return lines.join("\n");
}

function stringifyResultData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) {
      for (const item of record.content) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
          return String((item as Record<string, unknown>).text);
        }
      }
    }
    if (record.data != null) return stringifyResultData(record.data);
    if (typeof record.text === "string") return record.text;
    if (typeof record.response === "string") return record.response;
  }

  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function isSmallPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length <= 140) return true;
  return /^(summarize|rename|title|fix|clean up|format|one-line|one line|short answer)\b/i.test(trimmed);
}

function normalizeRunnerAddress(address: string | null): string | null {
  if (!address) return null;
  return address.toLowerCase();
}

function inferRunnerSizeHint(runner: RunnerInfo): string {
  const models = runner.rate_card.supported_models.join(" ").toLowerCase();
  if (/(72b|70b|405b|large)/.test(models)) return "large";
  if (/(3b|7b|8b|mini|small)/.test(models)) return "small";
  return "unknown";
}

function rankLlmRunners(runners: RunnerInfo[]): RunnerInfo[] {
  return [...runners].sort((a, b) => {
    const score = (runner: RunnerInfo) => {
      const size = inferRunnerSizeHint(runner);
      const sizeScore = size === "large" ? 200 : size === "small" ? 100 : 0;
      const capacityScore = runner.capabilities.max_concurrent_jobs;
      const priceScore = runner.rate_card.llm_output_token > 0 ? Math.max(1, 1_000_000 / runner.rate_card.llm_output_token) : 0;
      return sizeScore + capacityScore + priceScore;
    };
    return score(b) - score(a);
  });
}

function pickPreferredRunner(
  runners: RunnerInfo[],
  preferences: RunnerPreferences,
  preferredAddress: string | null
): RunnerInfo | null {
  const normalized = normalizeRunnerAddress(preferredAddress);
  if (!normalized) return null;
  return runners.find((runner) => normalizeRunnerAddress(runner.address) === normalized) ?? null;
}

function chooseRunnerRoute(
  prompt: string,
  runners: RunnerInfo[],
  preferences: RunnerPreferences
): {
  primary: RunnerInfo | null;
  helper: RunnerInfo | null;
  selected: RunnerInfo | null;
  route: "primary" | "helper";
  advisory: boolean;
} {
  const llmRunners = rankLlmRunners(
    runners.filter((runner) => runner.capabilities.job_types.includes("llm"))
  );

  const primary =
    pickPreferredRunner(llmRunners, preferences, preferences.primaryRunner) ??
    llmRunners[0] ??
    null;

  const helper =
    pickPreferredRunner(llmRunners, preferences, preferences.helperRunner) ??
    llmRunners.find((runner) => runner.address !== primary?.address) ??
    null;

  const useHelper =
    preferences.smallPromptRouting &&
    isSmallPrompt(prompt) &&
    helper != null;

  return {
    primary,
    helper,
    selected: useHelper ? helper : primary,
    route: useHelper ? "helper" : "primary",
    advisory: true,
  };
}

function formatRunnerList(
  runners: RunnerInfo[],
  preferences: RunnerPreferences
): string {
  if (runners.length === 0) {
    return "No active runners found.";
  }

  const llmSelection = chooseRunnerRoute("Summarize this", runners, preferences);
  const hdr = [
    "#".padEnd(4),
    "Role".padEnd(10),
    "Address".padEnd(44),
    "Jobs".padEnd(12),
    "Models".padEnd(18),
    "Rep".padStart(4),
    "Load".padStart(9),
  ].join("  ");
  const sep = "-".repeat(hdr.length);

  const rows = runners.map((runner, index) => {
    let role = "";
    if (llmSelection.primary?.address === runner.address) role = "primary";
    if (llmSelection.helper?.address === runner.address) role = role ? `${role},help` : "helper";

    return [
      String(index + 1).padEnd(4),
      role.padEnd(10),
      runner.address.padEnd(44),
      runner.capabilities.job_types.join(",").slice(0, 12).padEnd(12),
      runner.rate_card.supported_models.join(",").slice(0, 18).padEnd(18),
      String(runner.reputation).padStart(4),
      `${runner.active_jobs}/${runner.capabilities.max_concurrent_jobs}`.padStart(9),
    ].join("  ");
  });

  const notes = [
    `  Active runners (${runners.length})`,
    "  Primary/helper selection is advisory until capability-aware dispatch lands in the node.",
  ];

  if (llmSelection.primary) {
    notes.push(`  Current primary: ${llmSelection.primary.address}`);
  }
  if (llmSelection.helper) {
    notes.push(`  Current helper:  ${llmSelection.helper.address}`);
  }

  return [
    ...notes,
    "",
    `  ${hdr}`,
    `  ${sep}`,
    ...rows.map((row) => `  ${row}`),
  ].join("\n");
}

interface AppProps {
  initialConfig: ProjectConfig;
  hasProject: boolean;
}

interface IndexedMessage extends ConsoleMessage {
  id: number;
}

/** A sensitive action awaiting explicit y/n approval (COW-2463). The fields are
 *  what the ApprovalPrompt renders; the resolver lives in a ref. */
interface PendingApproval {
  title: string;
  summary: string;
  approveLabel: string;
  denyLabel: string;
}

/** Human explanation of what a mode does, shown by `/permissions` (COW-2463). */
function describePermissionMode(mode: PermissionMode): string {
  return mode === "auto"
    ? [
        "  Permission mode: auto",
        "",
        "  Governs what the AGENT does on this machine. Its reads and its writes",
        "  INSIDE the project run without prompting. Still always asks: writes",
        "  outside the project or to protected files (.git, .cowboy, keys, .env,",
        "  lockfiles), command execution, and anything needing a wallet signature.",
        "  A path that tries to escape the project is blocked outright.",
        "",
        "  Commands you type yourself (/actor deploy, /transfer, …) run as usual",
        "  — that's your own intent, not the agent's.",
        "  Session-only: resets to default when you restart lasso.",
      ].join("\n")
    : [
        "  Permission mode: default",
        "",
        "  Governs what the AGENT does on this machine. Its reads run without",
        "  prompting; its writes, command execution, and anything needing a",
        "  wallet signature ask for your approval first. A write that tries to",
        "  escape the project is blocked outright.",
        "",
        "  Commands you type yourself run as usual. Switch with /permissions set auto",
      ].join("\n");
}

// Map command name to cowboy CLI args
function commandToCowboyArgs(command: string, args: string[]): string[] {
  switch (command) {
    case "init":
      return ["init", ...args];
    case "actor-execute":
      return ["actor", "execute", ...args];
    case "actor-get":
      return ["actor", "get", ...args];
    case "actor-address":
      return ["actor", "address", ...args];
    case "actor-new":
      return ["actor", "new", ...args];
    case "actor-logs":
      return ["actor", "logs", ...args];
    case "runner-get":
      return ["runner", "get", ...args];
    case "runner-list":
      return ["runner", "list"];
    case "runner-register":
      return ["runner", "register", ...args];
    case "transfer":
      return ["transfer", ...args];
    case "wallet-create":
      return ["wallet", "create", ...args];
    case "wallet-address":
      return ["wallet", "address", ...args];
    case "wallet-balance":
      return ["wallet", "balance", ...args];
    case "wallet-export":
      return ["wallet", "export", ...args];
    case "wallet-import-hex":
      return ["wallet", "import-hex", ...args];
    case "wallet-import-mnemonic":
      return ["wallet", "import-mnemonic", ...args];
    case "token-create":
      return ["token", "create", ...args];
    case "token-transfer":
      return ["token", "transfer", ...args];
    case "token-approve":
      return ["token", "approve", ...args];
    case "token-mint":
      return ["token", "mint", ...args];
    case "token-burn":
      return ["token", "burn", ...args];
    case "token-info":
      return ["token", "info", ...args];
    case "token-balance":
      return ["token", "balance", ...args];
    case "token-list":
      return ["token", "list"];
    case "watchtower-new-feed":
      return ["watchtower", "new", "feed", ...args];
    case "watchtower-feed-publish":
      return ["watchtower", "feed", ...args];
    case "watchtower-feed-subscribers":
      return ["watchtower", "feed", ...args];
    case "watchtower-list":
      return ["watchtower", "list"];
    case "watchtower-feeds":
      return ["watchtower", "feeds"];
    default:
      return args;
  }
}

export function App({ initialConfig, hasProject: initialHasProject }: AppProps) {
  const { exit } = useApp();
  const [projectReady, setProjectReady] = useState(initialHasProject);
  const [session, setSession] = useState<SessionState>({
    validatorUrl: initialConfig.validatorUrl,
    dashboardUrl: initialConfig.dashboardUrl,
    walletAddress: initialConfig.walletAddress,
    runnerUrl: initialConfig.runnerUrl,
    actors: initialConfig.actors,
    runnerPreferences: initialConfig.runnerPreferences,
    aiHistory: [],
  });
  const [streamingText, setStreamingText] = useState("");
  const [messages, setMessages] = useState<IndexedMessage[]>([]);
  const nextIdRef = useRef(0);
  const [input, setInput] = useState<EditorBuffer>(() => createEditorState(""));
  const [isExecuting, setIsExecuting] = useState(false);
  // Agent-mode session state: one conversation per lasso session, created
  // lazily on the first AI prompt. abort ref lets Ctrl+C cancel a stream.
  const conversationIdRef = useRef<string | null>(null);
  const agentAbortRef = useRef<(() => void) | null>(null);
  // ask_user (PR #177): while a run blocks on a question, the next submitted
  // line is the ANSWER (not a new turn). answerResolverRef holds the resolver;
  // pendingQuestionRef holds the choices for number-shortcut mapping.
  const answerResolverRef = useRef<((answer: string) => void) | null>(null);
  const pendingQuestionRef = useRef<{ choices: string[] } | null>(null);
  const [awaitingAnswer, setAwaitingAnswer] = useState(false);
  // Aborts a local tool that's mid-run (COW-2457): Ctrl-C cancels the in-flight
  // dispatch (killing any CLI child), distinct from aborting the HTTP stream.
  const clientToolAbortRef = useRef<AbortController | null>(null);
  const [pendingExit, setPendingExit] = useState(false);
  const [activeWizard, setActiveWizard] = useState<"token-launch" | null>(null);
  const [walkthroughLesson, setWalkthroughLesson] = useState<number | null>(null);
  // Session-only permission mode (COW-2463). Deliberately NOT part of
  // SessionState / config: it must never persist, so a repo or tool can't leave
  // the client in `auto` for a later session. Resets to `default` every launch.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  // A sensitive action awaiting explicit user approval (COW-2455 / COW-2463).
  // `pendingApproval` holds what to show; the ref's resolver is fired by the
  // ApprovalPrompt with the user's y/n decision. `approvalChainRef` serializes
  // requests so two tools can never race two prompts onto the screen at once.
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const approvalRef = useRef<((approved: boolean) => void) | null>(null);
  const approvalChainRef = useRef<Promise<void>>(Promise.resolve());
  const [cowboyVersion, setCowboyVersion] = useState<string | null>(null);

  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const addMessage = useCallback(
    (role: ConsoleMessage["role"], content: string) => {
      const id = nextIdRef.current++;
      setMessages((prev) => [...prev, { id, role, content }]);
    },
    []
  );

  // The single approval gate (COW-2463). Every sensitive local action funnels
  // through here: policy is decided by the pure `decide()` — this only enforces
  // the decision (prompt / allow / refuse) and never re-derives it inline.
  //  - allow → run, no prompt (a non-read auto-approval still leaves an audit line).
  //  - ask   → show ApprovalPrompt and block on the user's y/n.
  //  - deny  → refuse outright (fail closed) with a loud audit line.
  // Serialized on approvalChainRef so concurrent tool requests queue instead of
  // clobbering each other's prompt.
  const requestApproval = useCallback(
    (
      permission: PermissionClass,
      details: {
        title: string;
        summary: string;
        approveLabel?: string;
        denyLabel?: string;
        /** Sandbox scope for a `write` (COW-2464): switches the decision to the
         *  path-aware `decideWrite` so an out-of-project / protected target is
         *  never auto-approved and a traversal is denied. */
        scope?: WriteScope;
      }
    ): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const decision =
          permission === "write" && details.scope
            ? decideWrite(details.scope, permissionMode)
            : decide(permission, permissionMode);
        if (decision === "allow") {
          // Reads are frequent and expected — stay quiet. Any other class being
          // auto-approved is a security-relevant event, so leave a trail.
          if (permission !== "read") {
            const scopeTag = permission === "write" && details.scope ? ` [${details.scope}]` : "";
            addMessage("system", `Auto-approved a ${permission} action${scopeTag} (${permissionMode} mode).`);
          }
          return true;
        }
        if (decision === "deny") {
          const why =
            permission === "write" && details.scope === "invalid"
              ? "the path escapes the project directory (blocked)"
              : "not permitted by the current policy";
          addMessage("error", `Refused a ${permission} action: ${why}.`);
          return false;
        }
        const approved = await new Promise<boolean>((resolve) => {
          approvalRef.current = resolve;
          setPendingApproval({
            title: details.title,
            summary: details.summary,
            approveLabel: details.approveLabel ?? "allow",
            denyLabel: details.denyLabel ?? "deny",
          });
        });
        setPendingApproval(null);
        approvalRef.current = null;
        return approved;
      };
      const result = approvalChainRef.current.then(run, run);
      approvalChainRef.current = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    [permissionMode, addMessage]
  );

  // Show warning if .cowboy directory not found
  useEffect(() => {
    if (!projectReady) {
      addMessage(
        "system",
        "No .cowboy/ project found in current directory. Run /init to get started on mesa (the public devnet), or /init local for a local node."
      );
      return;
    }
    addMessage(
      "system",
      "Slash commands start with /. Plain text starts the AI actor builder."
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect cowboy CLI version on mount
  useEffect(() => {
    getCowboyVersion().then(setCowboyVersion);
  }, []);

  // Best-effort update notice (LASSO_NO_UPDATE_CHECK=1 to disable)
  useEffect(() => {
    checkForUpdate(VERSION).then((latest) => {
      if (latest) {
        addMessage(
          "system",
          `lasso ${latest} is available (you have ${VERSION}): brew upgrade cowboyinc/lasso/lasso`
        );
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-detect wallet address from key file if not set
  useEffect(() => {
    if (projectReady && !session.walletAddress) {
      detectWalletAddress().then((addr) => {
        if (addr) {
          setSession((prev) => ({ ...prev, walletAddress: addr }));
        }
      });
    }
  }, [projectReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fund: a wallet with zero balance gets a faucet drip so new users
  // can deploy immediately. Attempted once per launch; /init already funds
  // freshly created projects via the cowboy CLI.
  const autoFundAttempted = useRef(false);
  useEffect(() => {
    if (!projectReady || !session.walletAddress || autoFundAttempted.current) return;
    autoFundAttempted.current = true;
    const { validatorUrl, walletAddress } = session;
    let cancelled = false;
    (async () => {
      const balance = await fetchAccountBalance(validatorUrl, walletAddress);
      if (cancelled || balance !== 0) return;
      try {
        const result = await requestFaucet(validatorUrl, walletAddress);
        if (!cancelled) {
          addMessage(
            "system",
            `Wallet balance was 0 - requested ${result.amountCby} CBY from the faucet (tx ${result.txHash.slice(0, 10)}...).`
          );
        }
      } catch (err: unknown) {
        if (!cancelled) {
          addMessage(
            "system",
            `Wallet balance is 0 and the faucet is unavailable (${err instanceof Error ? err.message : String(err)}). Try /faucet later.`
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectReady, session.walletAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateRunnerPrefs = useCallback((patch: Partial<RunnerPreferences>) => {
    setSession((prev) => {
      const runnerPreferences = { ...prev.runnerPreferences, ...patch };
      saveRunnerPreferences(runnerPreferences);
      return { ...prev, runnerPreferences };
    });
  }, []);

  const executeCommand = useCallback(
    async (command: string, args: string[], stdin?: string) => {
      // deploy-actor has special handling (salt generation + actor address extraction)
      if (command === "deploy-actor") {
        setIsExecuting(true);
        try {
          const { text: result, ok } = await deployActor(args[0], session.validatorUrl);
          if (!ok) {
            addMessage("error", result);
            return;
          }

          // Extract actor address and auto-label from filename
          const actorMatch = result.match(/Actor address:\s*(?:0x)?([a-fA-F0-9]{40})/);
          if (actorMatch) {
            const actorAddress = `0x${actorMatch[1]}`;
            const filePath = args[0];
            const fileName = basename(filePath, ".py");
            const label = fileName === "main" ? basename(dirname(filePath)) : fileName;
            setSession((prev) => {
              const exists = prev.actors.some((a) => a.address === actorAddress);
              const actors = exists
                ? prev.actors
                : [...prev.actors, { address: actorAddress, label }];
              saveActors(actors);
              return { ...prev, actors };
            });
          }

          // Truncate after the success line
          const cutIdx = result.indexOf("Actor deployment transaction submitted successfully");
          const trimmed = cutIdx !== -1
            ? result.slice(0, cutIdx + "Actor deployment transaction submitted successfully".length).trim()
            : result;

          addMessage("output", trimmed);
        } catch (err: unknown) {
          addMessage(
            "error",
            `Deploy failed: ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      // simulate — run a handler locally against the PVM (COW-2461). A command
      // the user typed is their own intent, so it runs without an approval gate
      // (like any slash command); the sandbox + bounds still apply inside.
      if (command === "simulate") {
        setIsExecuting(true);
        // Route through the same registry dispatch as the bridge so the direct
        // command inherits its guarantees: hard arg validation, a per-call
        // timeout, and the abort RACE (returns promptly even if `cowboy dev`
        // lingers after SIGTERM). Ctrl-C aborts via clientToolAbortRef.
        const controller = new AbortController();
        clientToolAbortRef.current = controller;
        try {
          const [file, handler, payload] = args;
          const simArgs: SimulateArgs = {
            actorPath: file,
            handler,
            ...(payload ? { payload } : {}),
          };
          const reg = new ToolRegistry();
          reg.register(makeSimulateTool());
          const res = await reg.dispatch(
            { toolUseId: "cli-simulate", toolName: SIMULATE_TOOL_NAME, args: simArgs },
            { timeoutMs: DEFAULT_TOOL_TIMEOUT_MS, signal: controller.signal }
          );
          if (res.status === "ok") {
            addMessage("output", formatSimulateResult(res.output as SimulateResult));
          } else if (res.status === "cancelled") {
            addMessage("error", res.reason === "timeout" ? "Simulate timed out." : "Simulate cancelled.");
          } else {
            // Sanitize: the message can carry a tool/filename-derived string.
            addMessage("error", sanitize(String((res.output as { message?: unknown })?.message ?? "simulate failed")));
          }
        } catch (err: unknown) {
          addMessage("error", sanitize(`Simulate failed: ${err instanceof Error ? err.message : String(err)}`));
        } finally {
          clientToolAbortRef.current = null;
          setIsExecuting(false);
        }
        return;
      }

      // actor get — fetch from validator RPC and format as key-value table
      if (command === "actor-get") {
        setIsExecuting(true);
        try {
          const address = args.find((a) => !a.startsWith("--")) ?? args[args.indexOf("--address") + 1];
          const detail = await fetchActorDetail(session.validatorUrl, address);
          const fullAddr = detail.address.startsWith("0x") ? detail.address : `0x${detail.address}`;
          const storageKeys = Object.keys(detail.storage).length;
          const rows = [
            `  Actor Details`,
            "",
            `  Address:        ${fullAddr}`,
            `  Code hash:      0x${detail.code_hash}`,
            `  Balance:        ${detail.balance.toLocaleString("en-US")}`,
            `  Nonce:          ${detail.nonce}`,
            `  Mailbox:        ${detail.mailbox_count}`,
            `  Storage keys:   ${storageKeys}`,
          ];
          if (storageKeys > 0 && storageKeys <= 20) {
            rows.push("");
            rows.push("  Storage:");
            for (const [k, v] of Object.entries(detail.storage)) {
              const safeVal = sanitize(v);
              const displayVal = safeVal.length > 60 ? `${safeVal.slice(0, 60)}...` : safeVal;
              rows.push(`    ${sanitize(k)}: ${displayVal}`);
            }
          }
          addMessage("output", rows.join("\n"));
        } catch (err: unknown) {
          addMessage("error", err instanceof Error ? err.message : String(err));
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      // actor list — fetch from dashboard if configured, else local-only
      if (command === "actor-list") {
        if (session.dashboardUrl && session.walletAddress) {
          setIsExecuting(true);
          try {
            const actors = await fetchMyActors(session.dashboardUrl, session.walletAddress);
            addMessage("output", formatActorList(actors, session.actors));
          } catch (err: unknown) {
            addMessage("error", `Failed to fetch actors: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setIsExecuting(false);
          }
        } else if (session.actors.length === 0) {
          addMessage("output", "No actors deployed yet.");
        } else {
          addMessage("output", formatLocalActorList(session.actors));
        }
        return;
      }

      // actor label sets a label on an existing actor
      if (command === "actor-label") {
        const identifier = args[0];
        const label = args.slice(1).join(" ");
        const pos = Number(identifier);
        let index = -1;

        if (!isNaN(pos) && !identifier.startsWith("0x")) {
          index = pos - 1;
        } else {
          index = session.actors.findIndex((a) => a.address === identifier);
        }

        if (index < 0 || index >= session.actors.length) {
          addMessage("error", `Actor not found: ${identifier}`);
          return;
        }

        setSession((prev) => {
          const actors = prev.actors.map((a, i) =>
            i === index ? { ...a, label } : a
          );
          saveActors(actors);
          return { ...prev, actors };
        });
        addMessage("output", `Label set: ${session.actors[index].address}  ${label}`);
        return;
      }

      if (command === "runner-list") {
        setIsExecuting(true);
        try {
          const runners = await fetchActiveRunners(session.validatorUrl);
          addMessage("output", formatRunnerList(runners, session.runnerPreferences));
        } catch (err: unknown) {
          addMessage("error", `Failed to fetch runners: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      if (command === "runner-get") {
        setIsExecuting(true);
        try {
          const address = args.find((a) => !a.startsWith("--")) ?? args[args.indexOf("--address") + 1];
          const runner = await fetchRunnerDetail(session.validatorUrl, address);
          const lines = [
            "  Runner Details",
            "",
            `  Address:       ${runner.address}`,
            `  Health:        ${runner.health}`,
            `  Reputation:    ${runner.reputation}`,
            `  Stake:         ${runner.stake.toLocaleString("en-US")}`,
            `  Jobs:          ${runner.capabilities.job_types.join(", ") || "-"}`,
            `  Models:        ${runner.rate_card.supported_models.join(", ") || "-"}`,
            `  Concurrency:   ${runner.active_jobs}/${runner.capabilities.max_concurrent_jobs}`,
          ];
          addMessage("output", lines.join("\n"));
        } catch (err: unknown) {
          addMessage("error", `Failed to fetch runner: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      if (command === "runner-primary" || command === "runner-helper") {
        const value = args[0] ?? "auto";
        const key = command === "runner-primary" ? "primaryRunner" : "helperRunner";
        if (value !== "auto" && !/^(0x)?[a-fA-F0-9]{40}$/.test(value)) {
          addMessage("error", `Invalid runner address: ${value}`);
          return;
        }
        updateRunnerPrefs({ [key]: value === "auto" ? null : value } as Partial<RunnerPreferences>);
        addMessage(
          "output",
          value === "auto"
            ? `${command === "runner-primary" ? "Primary" : "Helper"} runner reset to auto selection.`
            : `${command === "runner-primary" ? "Primary" : "Helper"} runner set to ${value}.`
        );
        return;
      }

      if (command === "job-status") {
        setIsExecuting(true);
        try {
          const status = await fetchJobStatus(session.validatorUrl, args[0]);
          addMessage("output", `Job ${status.job_id}\n\n  Status: ${status.status}`);
        } catch (err: unknown) {
          addMessage("error", `Failed to fetch job status: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      if (command === "job-results") {
        setIsExecuting(true);
        try {
          const results = await fetchJobResults(session.validatorUrl, args[0]);
          if (results.results.length === 0) {
            addMessage("output", `Job ${results.job_id}\n\n  No results yet.`);
          } else {
            const blocks = results.results.map((result, index) => [
              `  Result ${index + 1}`,
              `  Runner: ${result.runner}`,
              "",
              stringifyResultData(result.data),
            ].join("\n"));
            addMessage("output", [`Job ${results.job_id}`, "", ...blocks].join("\n\n"));
          }
        } catch (err: unknown) {
          addMessage("error", `Failed to fetch job results: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      if (command === "job-verified") {
        setIsExecuting(true);
        try {
          const verified = await fetchJobVerified(session.validatorUrl, args[0]);
          addMessage(
            "output",
            [
              `Job ${verified.job_id}`,
              "",
              `  Consensus: ${verified.consensus_count}/${verified.total_runners}`,
              "",
              stringifyResultData(verified.data),
            ].join("\n")
          );
        } catch (err: unknown) {
          addMessage("error", `Failed to fetch verified job result: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      if (command === "job-runners") {
        setIsExecuting(true);
        try {
          const results = await fetchJobResults(session.validatorUrl, args[0]);
          const runnerLines = results.results.map((result) => `  ${result.runner}`);
          addMessage(
            "output",
            runnerLines.length > 0
              ? [`Job ${results.job_id}`, "", "  Observed runners:", ...runnerLines].join("\n")
              : `Job ${results.job_id}\n\n  No runner results yet.`
          );
        } catch (err: unknown) {
          addMessage("error", `Failed to fetch job runners: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      // faucet — direct RPC request, defaults to the session wallet
      if (command === "faucet") {
        const address = args[0] ?? session.walletAddress;
        if (!address) {
          addMessage("error", "No wallet address known. Run /init first or pass one: /faucet <address>");
          return;
        }
        setIsExecuting(true);
        try {
          const result = await requestFaucet(session.validatorUrl, address);
          addMessage(
            "output",
            [
              `  Faucet request ${result.status}`,
              "",
              `  Recipient: ${address}`,
              `  Amount:    ${result.amountCby.toLocaleString("en-US")} CBY`,
              `  Tx:        ${result.txHash}`,
            ].join("\n")
          );
        } catch (err: unknown) {
          addMessage("error", `Faucet request failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      // init has special handling (extract wallet, replace next steps)
      if (command === "init") {
        setIsExecuting(true);
        // The cowboy CLI requests faucet funds during init; don't stack a
        // second drip when the wallet address lands in session state.
        autoFundAttempted.current = true;
        try {
          const cowboyArgs = commandToCowboyArgs(command, args);
          const { text: result, ok } = await executeCowboy(cowboyArgs, session.validatorUrl);
          if (!ok) {
            addMessage("error", result);
            return;
          }

          // Re-read project config written by the CLI
          const freshConfig = loadProjectConfig();
          if (freshConfig) {
            // CLI doesn't write wallet_address to config — extract from output
            const walletMatch = result.match(/Wallet address:\s*(0x[a-fA-F0-9]+)/);
            setSession({
              validatorUrl: freshConfig.validatorUrl,
              dashboardUrl: freshConfig.dashboardUrl,
              walletAddress: walletMatch ? walletMatch[1] : freshConfig.walletAddress,
              runnerUrl: freshConfig.runnerUrl,
              actors: freshConfig.actors,
              runnerPreferences: freshConfig.runnerPreferences,
              aiHistory: [],
            });
            setProjectReady(true);
          } else if (existsSync(join(process.cwd(), ".cowboy"))) {
            setProjectReady(true);
          }

          // Strip everything from "Next steps:" onward and replace
          const cleaned = result.replace(/\n?\s*Next steps:[\s\S]*$/, "").trim();

          const nextSteps = [
            "",
            " Next step deploy your first Actor:",
            "",
            "   # Deploy the starter actor created by init",
            "   /actor deploy actors/counter/main.py",
          ].join("\n");

          addMessage("output", cleaned + nextSteps);
        } catch (err: unknown) {
          addMessage(
            "error",
            `Init failed: ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      // token-list: format as table
      if (command === "token-list") {
        setIsExecuting(true);
        try {
          const cowboyArgs = commandToCowboyArgs(command, args);
          const { text: raw, ok } = await executeCowboy(cowboyArgs, session.validatorUrl);
          addMessage(ok ? "output" : "error", ok ? formatTokenList(raw) : raw);
        } catch (err: unknown) {
          addMessage("error", `Command failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setIsExecuting(false);
        }
        return;
      }

      setIsExecuting(true);
      try {
        const cowboyArgs = commandToCowboyArgs(command, args);
        const { text: result, ok } = await executeCowboy(
          cowboyArgs,
          session.validatorUrl,
          stdin,
        );
        addMessage(ok ? "output" : "error", result);
      } catch (err: unknown) {
        addMessage(
          "error",
          `Command failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setIsExecuting(false);
      }
    },
    [session, addMessage, updateRunnerPrefs]
  );

  const runAgentPrompt = useCallback(
    async (prompt: string) => {
      const dashboardUrl = session.dashboardUrl;
      if (!dashboardUrl) return;

      if (!session.walletAddress) {
        addMessage("error", "AI builder needs a wallet. Run /init to set one up.");
        return;
      }

      setIsExecuting(true);
      setStreamingText("");
      let streamed = "";

      try {
        // createConversation's firstMessage only seeds the conversation
        // title server-side — the backend explicitly does NOT persist it as
        // a chat turn (see dashboard backend conversations.ts) — so sending
        // the prompt via streamAgentChat below is not a duplicate.
        if (!conversationIdRef.current) {
          conversationIdRef.current = await createConversation(
            dashboardUrl,
            session.walletAddress,
            prompt
          );
        }

        // Inline any local .py files the user referenced, like the direct
        // path does — the backend can't read this machine's files. The
        // backend's own knowledge tool replaces the local knowledge pack.
        const content = prompt + collectLocalFileContext(prompt);

        // Local tool registry (COW-2455). Only signing is registered/advertised
        // until the permission gate + sandbox land (COW-2463/2464); the backend
        // only emits client_tool_request for advertised tools.
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(makeSignTool(signHashLocally));
        // Local simulate (COW-2461): advertised to the backend so it can run
        // simulate_actor on this machine instead of a runner round-trip. Gated
        // as the `simulate` class (auto-approved in auto, asks in default).
        toolRegistry.register(makeSimulateTool());

        const handle = streamAgentChat(dashboardUrl, {
          conversationId: conversationIdRef.current,
          content,
          // doc 61: run-until-done. The agent builds, tests, and self-corrects
          // across steps before reporting, instead of the build-then-stop wizard.
          mode: "agent",
          // Advertise generic tools only. Signing is excluded: it has no
          // approval gate on the generic path and keeps its dedicated approved
          // route (tool_pending_signature). In PR1 this list is empty.
          clientTools: toolRegistry
            .supportedNames()
            .filter((name) => name !== SIGN_TOOL_NAME),
        });
        agentAbortRef.current = handle.abort;

        const result = await runAgentTurn(handle.events, {
          // System lines interpolate backend-controlled text (tool names,
          // summaries) — strip control/ANSI sequences at this boundary so no
          // agent-turn path can smuggle terminal escapes to the TUI. Newlines
          // and tabs survive (the Plan checklist renders multi-line).
          onSystem: (text) => addMessage("system", stripTerminalControl(text)),
          onToken: (token) => {
            streamed += token;
            setStreamingText((prev) => prev + token);
          },
          writeActor: async (actor) => {
            // The backend controls the path, so classify it against the project
            // sandbox (COW-2464): the gate denies a traversal, always asks for
            // an outside/protected target, and (in auto) may auto-approve a
            // plain in-project write. Show the resolved target — a client-
            // derived fact — not just the backend's filePath string.
            const { scope, resolved, root } = classifyWritePath(actor.filePath);
            const approved = await requestApproval("write", {
              title: `Write ${actor.filePath}?`,
              summary: `Target: ${resolved || actor.filePath}\nScope: ${scope} (project root: ${root})\n${actor.code.length} bytes from the agent.`,
              scope,
            });
            if (!approved) return false;
            mkdirSync(dirname(resolved), { recursive: true });
            writeFileSync(resolved, actor.code + "\n", "utf-8");
            return true;
          },
          abort: handle.abort,
          // ask_user (PR #177): park until the user types the next line, then
          // POST it as the answer to resume the same run.
          onAskUser: (q) =>
            new Promise<void>((resolve) => {
              pendingQuestionRef.current = { choices: q.choices ?? [] };
              setAwaitingAnswer(true);
              answerResolverRef.current = async (answer) => {
                answerResolverRef.current = null;
                pendingQuestionRef.current = null;
                setAwaitingAnswer(false);
                try {
                  await postAnswerCallback(dashboardUrl, {
                    sessionId: q.sessionId,
                    toolUseId: q.toolUseId,
                    action: "answer",
                    answer,
                  });
                } catch (err) {
                  addMessage("error", err instanceof Error ? err.message : String(err));
                }
                resolve();
              };
            }),
          // Signing (COW-2465): REQUIRE explicit user approval, then dispatch
          // through the shared tool registry and post over the EXISTING
          // sign-callback wire. Dual-path — signing stays on this dedicated
          // event/route until the backend generalizes (COW-2455). lasso must
          // never sign a backend-provided hash unattended (COW-2463).
          resolvePendingSignature: async (req) => {
            const cancelBroker = async () => {
              try {
                await postSignCallback(dashboardUrl, {
                  sessionId: req.sessionId,
                  toolUseId: req.toolUseId,
                  action: "cancel",
                });
              } catch {
                /* ignore — the 5-minute broker timeout will clean up */
              }
            };

            // Block on explicit approval before touching the key. Signing is
            // class "sign", which `decide` forces to always-ask in every mode —
            // it can never be auto-approved. Show the exact hash to be signed
            // (client-derived) alongside the backend's human summary.
            const approved = await requestApproval("sign", {
              title: "Signature required",
              summary: `${req.summary}\n\nHash to sign: ${req.hashHex}`,
              approveLabel: "sign",
              denyLabel: "cancel",
            });
            if (!approved) {
              await cancelBroker();
              return "cancelled";
            }

            const signController = new AbortController();
            clientToolAbortRef.current = signController;
            const outcome = await toolRegistry.dispatch(
              {
                toolUseId: req.toolUseId,
                toolName: SIGN_TOOL_NAME,
                args: { hashHex: req.hashHex },
              },
              { signal: signController.signal }
            );
            clientToolAbortRef.current = null;
            if (outcome.status === "ok") {
              try {
                await postSignCallback(dashboardUrl, {
                  sessionId: req.sessionId,
                  toolUseId: req.toolUseId,
                  action: "sign",
                  signature: outcome.output as EcdsaSignature,
                });
                return "signed";
              } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
              }
            }
            // A mid-sign cancel (Ctrl-C / timeout, COW-2457) is graceful, not a
            // failure: cancel the broker and stop the turn cleanly, like the
            // pre-sign denial path — don't surface an "AI builder failed" error.
            if (outcome.status === "cancelled") {
              await cancelBroker();
              return "cancelled";
            }
            // Validation/signer failure: best-effort cancel so the backend loop
            // unblocks instead of waiting out the signature timeout.
            await cancelBroker();
            const message = String(
              (outcome.output as { message?: unknown })?.message ?? "signing failed"
            );
            return { error: message };
          },
          // Generic client-tool bridge (COW-2455). Dispatch the named local tool
          // and post its result over the new tool-result wire (inert until the
          // backend emits client_tool_request). A tool-level error is posted and
          // the loop continues (the agent handles it); only a transport failure
          // aborts, and a user cancel stops.
          dispatchClientTool: async (req, sessionId) => {
            // Signing is NOT offered over the generic bridge: it has no approval
            // gate on this path yet and keeps its dedicated approved route
            // (tool_pending_signature). Refuse it defensively even if a backend
            // requests it unadvertised, so a hash is never signed unattended.
            if (req.toolName === SIGN_TOOL_NAME) {
              try {
                await postToolResult(dashboardUrl, {
                  sessionId,
                  toolUseId: req.toolUseId,
                  status: "error",
                  output: {
                    message: "signing is not available over the generic tool bridge",
                  },
                });
              } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
              }
              return "continue";
            }

            // Permission gate (COW-2463). An unregistered/unclassified tool has
            // no permission class → fail closed: tell the agent it's unsupported
            // and never run it. Otherwise route through the approval gate.
            const permission = toolRegistry.permissionOf(req.toolName);
            if (permission === undefined) {
              try {
                await postToolResult(dashboardUrl, {
                  sessionId,
                  toolUseId: req.toolUseId,
                  status: "error",
                  output: { message: `unsupported local tool: ${req.toolName}` },
                });
              } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
              }
              return "continue";
            }

            const approved = await requestApproval(permission, {
              title: `Allow ${req.toolName}?`,
              summary: req.summary ?? `The agent wants to run ${req.toolName}.`,
            });
            if (!approved) {
              // User denial (or a fail-closed refusal) → post a cancelled result
              // so the backend loop unblocks, and stop the turn.
              try {
                await postToolResult(dashboardUrl, {
                  sessionId,
                  toolUseId: req.toolUseId,
                  status: "cancelled",
                  reason: "user_cancelled",
                });
              } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
              }
              return "stop";
            }

            const toolController = new AbortController();
            clientToolAbortRef.current = toolController;
            const toolResult = await toolRegistry.dispatch(req, {
              signal: toolController.signal,
            });
            clientToolAbortRef.current = null;
            try {
              await postToolResult(dashboardUrl, {
                sessionId,
                toolUseId: req.toolUseId,
                status: toolResult.status,
                output:
                  toolResult.status === "cancelled" ? undefined : toolResult.output,
                reason:
                  toolResult.status === "cancelled" ? toolResult.reason : undefined,
              });
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
            // A user cancel (Ctrl-C) halts the turn; a timeout posts a structured
            // result the backend can act on, so the loop continues (COW-2457).
            return toolResult.status === "cancelled" &&
              toolResult.reason === "user_cancelled"
              ? "stop"
              : "continue";
          },
        });

        if (result.error) {
          // Keep any partial stream for context, then the error banner last.
          if (streamed.trim()) {
            addMessage("output", streamed);
          }
          addMessage("error", `AI builder failed: ${result.error}`);
        } else {
          const finalText = result.finalText ?? streamed;
          if (finalText.trim()) {
            addMessage("output", finalText);
          }
        }
        if (result.wrote.length > 0) {
          addMessage("system", `Deploy with: /actor deploy ${result.wrote[0].filePath}`);
        }
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        if (!aborted) {
          // Keep whatever streamed before the disconnect, then explain.
          if (streamed.trim()) {
            addMessage("output", streamed);
          }
          // Show only the origin: a configured URL could embed credentials.
          let displayUrl = dashboardUrl;
          try {
            displayUrl = new URL(dashboardUrl).origin;
          } catch {
            // unparseable — leave as configured
          }
          addMessage(
            "error",
            `AI builder failed: ${err instanceof Error ? err.message : String(err)} — check dashboard_url in .cowboy/config.json (currently ${displayUrl})`
          );
        }
      } finally {
        agentAbortRef.current = null;
        setIsExecuting(false);
        setStreamingText("");
      }
    },
    [session, addMessage, requestApproval]
  );

  const handlePromptSubmit = useCallback(
    async (prompt: string) => {
      if (session.dashboardUrl) {
        await runAgentPrompt(prompt);
        return;
      }

      if (!session.runnerUrl) {
        addMessage(
          "error",
          "No AI endpoint configured. Set dashboard_url (or runner_url for direct mode) in .cowboy/config.json, or run /init."
        );
        return;
      }

      setIsExecuting(true);
      setStreamingText("");

      try {
        // Discover model on first call
        let model = "cowboy-actor";
        const discovered = await discoverModel(session.runnerUrl);
        if (discovered) model = discovered;

        // Ground the builder: retrieve matching knowledge-pack sections
        // into the system prompt, and pull in local .py files the user
        // referenced by path.
        const knowledgeContext = renderKnowledgeContext(retrieveSections(prompt, 1200));
        const localFileContext = collectLocalFileContext(prompt);

        // Build conversation with history
        const conversationHistory: ChatMessage[] = [
          ...session.aiHistory,
          { role: "user", content: prompt + localFileContext },
        ];

        const { messages: trimmedMessages, maxOutputTokens } = trimMessages(
          ACTOR_BUILDER_SYSTEM_PROMPT + knowledgeContext,
          conversationHistory
        );

        addMessage("system", `AI builder (${model})`);

        // Stream the response
        const fullResponse = await streamChat(
          session.runnerUrl,
          model,
          trimmedMessages,
          maxOutputTokens,
          {
            onToken: (token) => {
              setStreamingText((prev) => prev + token);
            },
            onDone: () => {
              setStreamingText("");
            },
            onError: (error) => {
              addMessage("error", error);
              setStreamingText("");
            },
          }
        );

        if (!fullResponse) {
          return;
        }

        // Add the full response as a message
        addMessage("output", fullResponse);

        // Update conversation history
        setSession((prev) => ({
          ...prev,
          aiHistory: [
            ...prev.aiHistory,
            { role: "user" as const, content: prompt },
            { role: "assistant" as const, content: fullResponse },
          ],
        }));

        // Extract and write actor files. Same write gate as the agent path
        // (COW-2463): ask before each file lands on disk.
        const actors = extractActors(fullResponse);
        const writtenPaths: string[] = [];
        for (const actor of actors) {
          // Same sandbox gate as the agent path (COW-2464).
          const { scope, resolved, root } = classifyWritePath(actor.filePath);
          const approved = await requestApproval("write", {
            title: `Write ${actor.filePath}?`,
            summary: `Target: ${resolved || actor.filePath}\nScope: ${scope} (project root: ${root})\n${actor.code.length} bytes.`,
            scope,
          });
          if (!approved) {
            addMessage("system", `Skipped ${actor.filePath} (not approved).`);
            continue;
          }
          mkdirSync(dirname(resolved), { recursive: true });
          writeFileSync(resolved, actor.code + "\n", "utf-8");
          addMessage(
            "system",
            `Wrote ${actor.className ?? "actor"} to ${actor.filePath}`
          );
          writtenPaths.push(actor.filePath);
        }

        if (writtenPaths.length > 0) {
          addMessage(
            "system",
            `Deploy with: /actor deploy ${writtenPaths[0]}`
          );
        }
      } catch (err: unknown) {
        addMessage(
          "error",
          `AI builder failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setIsExecuting(false);
        setStreamingText("");
      }
    },
    [session, addMessage, runAgentPrompt, requestApproval]
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();

      // ask_user answer path (PR #177): while a run blocks on a question, the
      // next line is the ANSWER, not a new turn — so this runs even while
      // isExecuting. A bare number picks the matching choice; else free text.
      if (answerResolverRef.current) {
        if (!trimmed) return;
        setInput(createEditorState(""));
        addMessage("command", trimmed);
        const choices = pendingQuestionRef.current?.choices ?? [];
        const n = Number(trimmed);
        const answer =
          Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1] : trimmed;
        answerResolverRef.current(answer);
        return;
      }

      if (!trimmed || isExecuting) return;

      setInput(createEditorState(""));
      setPendingExit(false);

      setHistory((prev) => [...prev, trimmed]);
      setHistoryIndex(-1);

      addMessage("command", trimmed);

      const result = parseCommand(trimmed);

      switch (result.type) {
        case "output":
          if (result.text) addMessage("output", result.text);
          break;

        case "error":
          addMessage("error", result.text);
          break;

        case "clear":
          setMessages([]);
          setSession((prev) => ({ ...prev, aiHistory: [] }));
          break;

        case "quit":
          exit();
          break;

        case "wizard":
          if (!projectReady) {
            addMessage("error", "No project initialized. Run /init first.");
            break;
          }
          setActiveWizard(result.wizard);
          break;

        case "walkthrough": {
          const lesson = result.lesson ?? 1;
          if (lesson > WALKTHROUGH_LESSONS.length) {
            addMessage("error", `There are ${WALKTHROUGH_LESSONS.length} lessons. Usage: /walkthrough [1-${WALKTHROUGH_LESSONS.length}]`);
            break;
          }
          setWalkthroughLesson(lesson);
          break;
        }

        case "docs": {
          if (!result.topic) {
            addMessage("output", docsIndex());
            break;
          }
          const section = getDocSection(result.topic);
          if (!section) {
            addMessage("error", `No doc topic matches "${result.topic}". Run /docs to list topics.`);
            break;
          }
          addMessage("output", `  ${section.title}\n\n${section.body}`);
          break;
        }

        case "execute":
          if (!projectReady && result.command !== "init" && result.command !== "faucet") {
            addMessage("error", "No project initialized. Run /init first.");
            break;
          }
          await executeCommand(result.command, result.args, result.stdin);
          break;

        case "permissions":
          if (result.mode === null) {
            addMessage("output", describePermissionMode(permissionMode));
          } else {
            setPermissionMode(result.mode);
            addMessage(
              "system",
              result.mode === "auto"
                ? "Permission mode set to auto (session-only). The agent's in-project writes run without prompting; writes outside the project or to protected files, and anything needing your wallet signature, still always ask."
                : "Permission mode set to default."
            );
          }
          break;

        case "prompt":
          if (!projectReady) {
            addMessage("error", "No project initialized. Run /init first.");
            break;
          }
          await handlePromptSubmit(result.text);
          break;
      }
    },
    [isExecuting, exit, addMessage, executeCommand, handlePromptSubmit, projectReady, permissionMode]
  );

  const handleHistoryUp = useCallback(() => {
    if (history.length === 0) return;
    const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
    setHistoryIndex(newIndex);
    setPendingExit(false);
    setInput(createEditorState(history[newIndex]));
  }, [history, historyIndex]);

  const handleHistoryDown = useCallback(() => {
    if (historyIndex === -1) return;
    const newIndex = historyIndex + 1;
    if (newIndex >= history.length) {
      setHistoryIndex(-1);
      setInput(createEditorState(""));
    } else {
      setHistoryIndex(newIndex);
      setInput(createEditorState(history[newIndex]));
    }
    setPendingExit(false);
  }, [history, historyIndex]);

  const handleInputChange = useCallback((nextInput: EditorBuffer) => {
    setPendingExit(false);
    setInput(nextInput);
  }, []);

  const handleInputActivity = useCallback(() => {
    setPendingExit(false);
  }, []);

  const handleTokenLaunch = useCallback(
    async (args: string[]) => {
      setActiveWizard(null);
      addMessage("command", `/token create ${args.join(" ")}`);
      setIsExecuting(true);
      try {
        const cowboyArgs = commandToCowboyArgs("token-create", args);
        const { text: result, ok } = await executeCowboy(cowboyArgs, session.validatorUrl);
        addMessage(ok ? "output" : "error", result);
      } catch (err: unknown) {
        addMessage(
          "error",
          `Token launch failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setIsExecuting(false);
      }
    },
    [session, addMessage]
  );

  const handleWizardCancel = useCallback(() => {
    setActiveWizard(null);
    addMessage("system", "Token launch cancelled.");
  }, [addMessage]);

  const handleInterrupt = useCallback(() => {
    if (isExecuting) {
      // Cancel an in-flight local tool first (COW-2457) — kills its CLI child
      // and yields a `cancelled` result — then tear down the stream.
      if (clientToolAbortRef.current) {
        clientToolAbortRef.current.abort();
        clientToolAbortRef.current = null;
      }
      if (agentAbortRef.current) {
        agentAbortRef.current();
        addMessage("system", "Interrupted.");
      } else {
        addMessage("system", "Cannot interrupt — waiting for response.");
      }
      return;
    }

    if (input.value.length > 0) {
      setInput(createEditorState(""));
      setPendingExit(true);
      return;
    }

    if (shouldExitOnInterrupt({ value: input.value, pendingExit })) {
      exit();
      return;
    }

    setPendingExit(true);
    addMessage("system", "Press Ctrl+C again to exit.");
  }, [addMessage, exit, input.value, isExecuting, pendingExit]);

  return (
    <Box flexDirection="column">
      <Static items={[{ id: "header", type: "header" as const }, ...messages]}>
        {(item) => {
          if ("type" in item && item.type === "header") {
            return <Header key="header" />;
          }
          const msg = item as IndexedMessage;
          return <Message key={`msg-${msg.id}`} message={msg} />;
        }}
      </Static>

      {isExecuting && (
        streamingText ? (
          <Message message={{ role: "output", content: streamingText + " ..." }} />
        ) : (
          <ThinkingSpinner />
        )
      )}

      {walkthroughLesson !== null ? (
        <WalkthroughPager
          initialLesson={walkthroughLesson}
          onExit={(completed) => {
            setWalkthroughLesson(null);
            addMessage(
              "system",
              completed
                ? "Walkthrough complete. /init to get set up, /docs for reference topics, or just describe what you want to build."
                : "Walkthrough closed. Resume any time with /walkthrough."
            );
          }}
        />
      ) : activeWizard === "token-launch" ? (
        <TokenLaunchWizard
          walletAddress={session.walletAddress}
          onLaunch={handleTokenLaunch}
          onCancel={handleWizardCancel}
          onMessage={addMessage}
        />
      ) : pendingApproval !== null ? (
        <ApprovalPrompt
          title={pendingApproval.title}
          summary={pendingApproval.summary}
          approveLabel={pendingApproval.approveLabel}
          denyLabel={pendingApproval.denyLabel}
          onApprove={() => approvalRef.current?.(true)}
          onDeny={() => approvalRef.current?.(false)}
        />
      ) : (
        <InputArea
          input={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          onInterrupt={handleInterrupt}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
          onActivity={handleInputActivity}
          isDisabled={isExecuting && !awaitingAnswer}
        />
      )}

      <StatusBar
        validatorUrl={session.validatorUrl}
        hasKey={projectReady}
        walletAddress={session.walletAddress}
        cowboyVersion={cowboyVersion}
        runnerPreferences={session.runnerPreferences}
        runnerUrl={session.runnerUrl}
        dashboardUrl={session.dashboardUrl}
        permissionMode={permissionMode}
      />
    </Box>
  );
}
