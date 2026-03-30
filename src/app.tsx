import React, { useState, useCallback, useEffect, useRef } from "react";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Static, useApp } from "ink";
import { Header } from "./components/Header.js";
import { Message } from "./components/Message.js";
import { ThinkingSpinner } from "./components/ThinkingSpinner.js";
import { InputArea } from "./components/InputArea.js";
import { StatusBar } from "./components/StatusBar.js";
import { parseCommand } from "./commands/index.js";
import { deployActor, executeCowboy, getCowboyVersion, fetchMyActors, fetchActorDetail, detectWalletAddress } from "./executor.js";
import type { ActorInfo } from "./executor.js";
import { loadProjectConfig, saveActors } from "./config.js";
import { basename, dirname } from "node:path";
import { createEditorState, shouldExitOnInterrupt } from "./editor-state.js";
import { TokenLaunchWizard } from "./components/TokenLaunchWizard.js";
import type { ActorEntry, ProjectConfig, ConsoleMessage, SessionState, EditorBuffer } from "./types.js";

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

interface AppProps {
  initialConfig: ProjectConfig;
  hasProject: boolean;
}

interface IndexedMessage extends ConsoleMessage {
  id: number;
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
    actors: initialConfig.actors,
  });
  const [messages, setMessages] = useState<IndexedMessage[]>([]);
  const nextIdRef = useRef(0);
  const [input, setInput] = useState<EditorBuffer>(() => createEditorState(""));
  const [isExecuting, setIsExecuting] = useState(false);
  const [pendingExit, setPendingExit] = useState(false);
  const [activeWizard, setActiveWizard] = useState<"token-launch" | null>(null);
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

  // Show warning if .cowboy directory not found
  useEffect(() => {
    if (!projectReady) {
      addMessage(
        "system",
        "No .cowboy/ project found in current directory. Run init <local|dev> to start."
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect cowboy CLI version on mount
  useEffect(() => {
    getCowboyVersion().then(setCowboyVersion);
  }, []);

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

  const executeCommand = useCallback(
    async (command: string, args: string[]) => {
      // deploy-actor has special handling (salt generation + actor address extraction)
      if (command === "deploy-actor") {
        setIsExecuting(true);
        try {
          const result = await deployActor(args[0], session.validatorUrl);

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

      // init has special handling (extract wallet, replace next steps)
      if (command === "init") {
        setIsExecuting(true);
        try {
          const cowboyArgs = commandToCowboyArgs(command, args);
          const result = await executeCowboy(cowboyArgs, session.validatorUrl);

          // Re-read project config written by the CLI
          const freshConfig = loadProjectConfig();
          if (freshConfig) {
            // CLI doesn't write wallet_address to config — extract from output
            const walletMatch = result.match(/Wallet address:\s*(0x[a-fA-F0-9]+)/);
            setSession({
              validatorUrl: freshConfig.validatorUrl,
              dashboardUrl: freshConfig.dashboardUrl,
              walletAddress: walletMatch ? walletMatch[1] : freshConfig.walletAddress,
              actors: freshConfig.actors,
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
            "   # Deploy to dev validator",
            "   actor deploy actors/hello/main.py",
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
          const raw = await executeCowboy(cowboyArgs, session.validatorUrl);
          addMessage("output", formatTokenList(raw));
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
        const result = await executeCowboy(
          cowboyArgs,
          session.validatorUrl
        );
        addMessage("output", result);
      } catch (err: unknown) {
        addMessage(
          "error",
          `Command failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setIsExecuting(false);
      }
    },
    [session, addMessage]
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
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
          break;

        case "quit":
          exit();
          break;

        case "wizard":
          if (!projectReady) {
            addMessage("error", "No project initialized. Run init <local|dev> first.");
            break;
          }
          setActiveWizard(result.wizard);
          break;

        case "execute":
          if (!projectReady && result.command !== "init") {
            addMessage("error", "No project initialized. Run init <local|dev> first.");
            break;
          }
          await executeCommand(result.command, result.args);
          break;
      }
    },
    [isExecuting, exit, addMessage, executeCommand]
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
      addMessage("command", `token create ${args.join(" ")}`);
      setIsExecuting(true);
      try {
        const cowboyArgs = commandToCowboyArgs("token-create", args);
        const result = await executeCowboy(cowboyArgs, session.validatorUrl);
        addMessage("output", result);
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
    if (isExecuting) return;

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

      {isExecuting && <ThinkingSpinner />}

      {activeWizard === "token-launch" ? (
        <TokenLaunchWizard
          walletAddress={session.walletAddress}
          onLaunch={handleTokenLaunch}
          onCancel={handleWizardCancel}
          onMessage={addMessage}
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
          isDisabled={isExecuting}
        />
      )}

      <StatusBar
        validatorUrl={session.validatorUrl}
        hasKey={projectReady}
        walletAddress={session.walletAddress}
        cowboyVersion={cowboyVersion}
      />
    </Box>
  );
}
