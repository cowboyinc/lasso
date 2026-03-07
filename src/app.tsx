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
import { deployActor, executeCowboy } from "./executor.js";
import { loadConfig, saveConfig } from "./config.js";
import type { LassoConfig, ConsoleMessage, SessionState } from "./types.js";

interface AppProps {
  initialConfig: LassoConfig;
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
    default:
      return args;
  }
}

export function App({ initialConfig, hasProject: initialHasProject }: AppProps) {
  const { exit } = useApp();
  const [projectReady, setProjectReady] = useState(initialHasProject);
  const [session, setSession] = useState<SessionState>({
    validatorUrl: initialConfig.validatorUrl,
    walletAddress: initialConfig.walletAddress ?? null,
    actors: initialConfig.actors ?? [],
  });
  const [messages, setMessages] = useState<IndexedMessage[]>([]);
  const nextIdRef = useRef(0);
  const [input, setInput] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [showLogo, setShowLogo] = useState(true);
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
          const result = await deployActor(
            args[0],
            session.validatorUrl
          );

          // Extract actor address and save to config
          const actorMatch = result.match(/Actor address:\s*([a-fA-F0-9]+)/);
          if (actorMatch) {
            const actorAddress = actorMatch[1];
            setSession((prev) => {
              const actors = prev.actors.includes(actorAddress)
                ? prev.actors
                : [...prev.actors, actorAddress];
              saveConfig({ ...initialConfig, walletAddress: prev.walletAddress ?? undefined, actors });
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

      // actor list is lasso-only (not a cowboy CLI command)
      if (command === "actor-list") {
        if (session.actors.length === 0) {
          addMessage("output", "No actors deployed yet.");
        } else {
          const list = session.actors.map((a, i) => `  ${i + 1}. ${a}`).join("\n");
          addMessage("output", `Deployed actors:\n${list}`);
        }
        return;
      }

      // init has special handling (extract wallet, replace next steps)
      if (command === "init") {
        setIsExecuting(true);
        try {
          const cowboyArgs = commandToCowboyArgs(command, args);
          const result = await executeCowboy(cowboyArgs, session.validatorUrl);

          // Extract wallet address and reload config (picks up new rpc_url)
          const walletMatch = result.match(/Wallet address:\s*(0x[a-fA-F0-9]+)/);
          if (walletMatch) {
            const walletAddress = walletMatch[1];
            const freshConfig = loadConfig();
            setSession((prev) => ({ ...prev, walletAddress, validatorUrl: freshConfig.validatorUrl }));
            saveConfig({ ...freshConfig, walletAddress });
          }

          // Mark project as ready (init creates .cowboy/)
          if (existsSync(join(process.cwd(), ".cowboy"))) {
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

      setInput("");
      setShowLogo(false);
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
    setInput(history[newIndex]);
  }, [history, historyIndex]);

  const handleHistoryDown = useCallback(() => {
    if (historyIndex === -1) return;
    const newIndex = historyIndex + 1;
    if (newIndex >= history.length) {
      setHistoryIndex(-1);
      setInput("");
    } else {
      setHistoryIndex(newIndex);
      setInput(history[newIndex]);
    }
  }, [history, historyIndex]);

  return (
    <Box flexDirection="column">
      <Static items={showLogo ? [{ id: "header", type: "header" as const }, ...messages] : messages}>
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
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onHistoryUp={handleHistoryUp}
        onHistoryDown={handleHistoryDown}
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
