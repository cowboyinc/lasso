import React, { useState, useCallback, useEffect, useRef } from "react";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Static, useApp, useInput } from "ink";
import { Header } from "./components/Header.js";
import { Message } from "./components/Message.js";
import { ThinkingSpinner } from "./components/ThinkingSpinner.js";
import { InputArea } from "./components/InputArea.js";
import { StatusBar } from "./components/StatusBar.js";
import { CompletionCache, getCompletionResult } from "./commands/autocomplete.js";
import { parseCommand } from "./commands/index.js";
import { startCowboyCommand, startDeployActor } from "./executor.js";
import { loadProjectConfig, saveActors, saveFeeds } from "./config.js";
import { basename, dirname } from "node:path";
import {
  acceptSuggestion,
  createEditorState,
  getInterruptAction,
  matchesSuggestionContext,
  moveSuggestionSelection,
  openSuggestions,
} from "./editor-state.js";
import type { ActorEntry, FeedEntry, ProjectConfig, ConsoleMessage, SessionState, EditorBuffer, SuggestionMenu } from "./types.js";

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
    walletAddress: initialConfig.walletAddress,
    actors: initialConfig.actors,
    feeds: initialConfig.feeds,
  });
  const [messages, setMessages] = useState<IndexedMessage[]>([]);
  const nextIdRef = useRef(0);
  const [input, setInput] = useState<EditorBuffer>(() => createEditorState(""));
  const [suggestions, setSuggestions] = useState<SuggestionMenu | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [pendingExit, setPendingExit] = useState(false);
  const activeExecutionRef = useRef<null | { cancel: () => void }>(null);
  const completionCacheRef = useRef(new CompletionCache());

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

  const executeCommand = useCallback(
    async (command: string, args: string[]) => {
      // deploy-actor has special handling (salt generation + actor address extraction)
      if (command === "deploy-actor") {
        setIsExecuting(true);
        try {
          const execution = startDeployActor(args[0], session.validatorUrl);
          activeExecutionRef.current = execution;
          const result = await execution.promise;
          activeExecutionRef.current = null;

          if (result.status === "interrupted") {
            addMessage("system", "Command interrupted.");
            return;
          }

          // Extract actor address and auto-label from filename
          const actorMatch = result.output.match(/Actor address:\s*(?:0x)?([a-fA-F0-9]{40})/);
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
              completionCacheRef.current.invalidate("actor");
              return { ...prev, actors };
            });
          }

          // Truncate after the success line
          const cutIdx = result.output.indexOf("Actor deployment transaction submitted successfully");
          const trimmed = cutIdx !== -1
            ? result.output.slice(0, cutIdx + "Actor deployment transaction submitted successfully".length).trim()
            : result.output;

          addMessage("output", trimmed);
        } catch (err: unknown) {
          addMessage(
            "error",
            `Deploy failed: ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          activeExecutionRef.current = null;
          setIsExecuting(false);
        }
        return;
      }

      // actor list is lasso-only (not a cowboy CLI command)
      if (command === "actor-list") {
        if (session.actors.length === 0) {
          addMessage("output", "No actors deployed yet.");
        } else {
          const list = session.actors
            .map((a, i) => {
              const suffix = a.label ? `  ${a.label}` : "";
              return `  ${i + 1}. ${a.address}${suffix}`;
            })
            .join("\n");
          addMessage("output", `Deployed actors:\n${list}`);
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
          completionCacheRef.current.invalidate("actor");
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
          const execution = startCowboyCommand(cowboyArgs, session.validatorUrl);
          activeExecutionRef.current = execution;
          const result = await execution.promise;
          activeExecutionRef.current = null;

          if (result.status === "interrupted") {
            addMessage("system", "Command interrupted.");
            return;
          }

          // Re-read project config written by the CLI
          const freshConfig = loadProjectConfig();
          if (freshConfig) {
            // CLI doesn't write wallet_address to config — extract from output
            const walletMatch = result.output.match(/Wallet address:\s*(0x[a-fA-F0-9]+)/);
            setSession({
              validatorUrl: freshConfig.validatorUrl,
              walletAddress: walletMatch ? walletMatch[1] : freshConfig.walletAddress,
              actors: freshConfig.actors,
              feeds: freshConfig.feeds,
            });
            completionCacheRef.current.invalidate();
            setProjectReady(true);
          } else if (existsSync(join(process.cwd(), ".cowboy"))) {
            setProjectReady(true);
          }

          // Strip everything from "Next steps:" onward and replace
          const cleaned = result.output.replace(/\n?\s*Next steps:[\s\S]*$/, "").trim();

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
          activeExecutionRef.current = null;
          setIsExecuting(false);
        }
        return;
      }

      setIsExecuting(true);
      try {
        const cowboyArgs = commandToCowboyArgs(command, args);
        const execution = startCowboyCommand(cowboyArgs, session.validatorUrl);
        activeExecutionRef.current = execution;
        const result = await execution.promise;
        activeExecutionRef.current = null;

        if (result.status === "interrupted") {
          addMessage("system", "Command interrupted.");
          return;
        }

        if (command === "watchtower-new-feed") {
          const feed = extractFeedEntry(result.output, args);
          if (feed) {
            setSession((prev) => {
              const exists = prev.feeds.some((entry) => entry.id === feed.id);
              const feeds = exists ? prev.feeds : [...prev.feeds, feed];
              saveFeeds(feeds);
              completionCacheRef.current.invalidate("feed");
              return { ...prev, feeds };
            });
          }
        }

        addMessage("output", result.output || "Command completed (no output)");
      } catch (err: unknown) {
        addMessage(
          "error",
          `Command failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        activeExecutionRef.current = null;
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
      setSuggestions(null);
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
    setSuggestions(null);
    setInput(createEditorState(history[newIndex]));
  }, [history, historyIndex]);

  const handleHistoryDown = useCallback(() => {
    if (historyIndex === -1) return;
    const newIndex = historyIndex + 1;
    if (newIndex >= history.length) {
      setHistoryIndex(-1);
      setSuggestions(null);
      setInput(createEditorState(""));
    } else {
      setHistoryIndex(newIndex);
      setSuggestions(null);
      setInput(createEditorState(history[newIndex]));
    }
    setPendingExit(false);
  }, [history, historyIndex]);

  const handleInputChange = useCallback((nextInput: EditorBuffer) => {
    setPendingExit(false);
    setSuggestions(null);
    setInput(nextInput);
  }, []);

  const handleAutocomplete = useCallback(() => {
    void (async () => {
      const match = await getCompletionResult({
        input: input.value,
        cursorOffset: input.cursorOffset,
        cwd: process.cwd(),
        session,
        cache: completionCacheRef.current,
      });

      if (!match) {
        setSuggestions(null);
        return;
      }

      if (suggestions && matchesSuggestionContext(suggestions, {
        tokenStart: match.tokenStart,
        tokenEnd: match.tokenEnd,
        items: match.items,
      }, input)) {
        setSuggestions(moveSuggestionSelection(suggestions, 1));
        return;
      }

      const result = openSuggestions(input, {
        tokenStart: match.tokenStart,
        tokenEnd: match.tokenEnd,
        items: match.items,
      });
      setPendingExit(false);
      setInput(result.nextState);
      setSuggestions(result.menu);
    })();
  }, [input, session, suggestions]);

  const handleSuggestionNext = useCallback(() => {
    if (!suggestions) return;
    setSuggestions(moveSuggestionSelection(suggestions, 1));
  }, [suggestions]);

  const handleSuggestionPrevious = useCallback(() => {
    if (!suggestions) return;
    setSuggestions(moveSuggestionSelection(suggestions, -1));
  }, [suggestions]);

  const handleSuggestionAccept = useCallback(() => {
    if (!suggestions) return;
    setInput(acceptSuggestion(input, suggestions));
    setSuggestions(null);
    setPendingExit(false);
  }, [input, suggestions]);

  const handleSuggestionDismiss = useCallback(() => {
    setSuggestions(null);
  }, []);

  const handleInputActivity = useCallback(() => {
    setPendingExit(false);
  }, []);

  const handleInterrupt = useCallback(() => {
    const action = getInterruptAction({
      inputValue: input.value,
      pendingExit,
      isExecuting,
    });

    if (action === "cancel-execution") {
      setPendingExit(false);
      setSuggestions(null);
      activeExecutionRef.current?.cancel();
      return;
    }

    if (action === "clear-input") {
      setInput(createEditorState(""));
      setSuggestions(null);
      setPendingExit(true);
      return;
    }

    if (action === "exit") {
      exit();
      return;
    }

    setPendingExit(true);
    addMessage("system", "Press Ctrl+C again to exit.");
  }, [addMessage, exit, input.value, isExecuting, pendingExit]);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      handleInterrupt();
    }
  });

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

        <InputArea
          input={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          onAutocomplete={handleAutocomplete}
          onSuggestionNext={handleSuggestionNext}
          onSuggestionPrevious={handleSuggestionPrevious}
          onSuggestionAccept={handleSuggestionAccept}
          onSuggestionDismiss={handleSuggestionDismiss}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
          onActivity={handleInputActivity}
          suggestions={suggestions}
          isDisabled={isExecuting}
      />

      <StatusBar
        validatorUrl={session.validatorUrl}
        hasKey={projectReady}
        walletAddress={session.walletAddress}
      />
    </Box>
  );
}

function extractFeedEntry(output: string, args: string[]): FeedEntry | null {
  const idMatch = output.match(/Feed(?:\s+ID)?\s*:\s*([A-Za-z0-9._:-]+)/i);
  if (!idMatch) {
    return null;
  }

  const nameIndex = args.indexOf("--name");
  return {
    id: idMatch[1],
    name: nameIndex >= 0 ? args[nameIndex + 1] : undefined,
  };
}
