import React, { useState, useCallback } from "react";
import { Box, Static, useApp } from "ink";
import { Header } from "./components/Header.js";
import { Message } from "./components/Message.js";
import { ThinkingSpinner } from "./components/ThinkingSpinner.js";
import { InputArea } from "./components/InputArea.js";
import { StatusBar } from "./components/StatusBar.js";
import { InitForm } from "./components/InitForm.js";
import { parseCommand } from "./commands/index.js";
import { deployActor } from "./executor.js";
import type { LassoConfig, ConsoleMessage, SessionState } from "./types.js";

interface AppProps {
  initialConfig: LassoConfig;
}

interface IndexedMessage extends ConsoleMessage {
  id: number;
}

export function App({ initialConfig }: AppProps) {
  const { exit } = useApp();
  const [session, setSession] = useState<SessionState>({
    privateKey: null,
    validatorUrl: initialConfig.validatorUrl,
  });
  const [messages, setMessages] = useState<IndexedMessage[]>([]);
  const [nextId, setNextId] = useState(0);
  const [input, setInput] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [showLogo, setShowLogo] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const addMessage = useCallback(
    (role: ConsoleMessage["role"], content: string) => {
      setMessages((prev) => [...prev, { id: nextId, role, content }]);
      setNextId((n) => n + 1);
    },
    [nextId]
  );

  const executeDeployActor = useCallback(
    async (filePath: string) => {
      if (!session.privateKey) {
        addMessage("error", "No key configured. Run init first.");
        return;
      }

      setIsExecuting(true);
      try {
        const result = await deployActor(
          session.privateKey,
          filePath,
          session.validatorUrl
        );
        addMessage("output", result);
      } catch (err: unknown) {
        addMessage(
          "error",
          `Deploy failed: ${err instanceof Error ? err.message : String(err)}`
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

        case "init":
          setIsInitializing(true);
          break;

        case "execute":
          if (result.command === "deploy-actor") {
            await executeDeployActor(result.args[0]);
          }
          break;
      }
    },
    [isExecuting, exit, addMessage, executeDeployActor]
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

  const handleInitComplete = useCallback(
    (privateKey: string) => {
      setSession((prev) => ({ ...prev, privateKey }));
      setIsInitializing(false);
      addMessage("system", "Private key set for this session.");
    },
    [addMessage]
  );

  const handleInitCancel = useCallback(() => {
    setIsInitializing(false);
    addMessage("system", "Init cancelled.");
  }, [addMessage]);

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

      {isInitializing ? (
        <InitForm onComplete={handleInitComplete} onCancel={handleInitCancel} />
      ) : (
        <InputArea
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
          isDisabled={isExecuting}
        />
      )}

      <StatusBar
        validatorUrl={session.validatorUrl}
        hasKey={session.privateKey !== null}
      />
    </Box>
  );
}
