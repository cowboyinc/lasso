import React, { useState, useCallback, useEffect } from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { LineEditor } from "./LineEditor.js";
import { createEditorState } from "../editor-state.js";
import type { EditorBuffer } from "../types.js";

interface TokenLaunchWizardProps {
  walletAddress: string | null;
  onLaunch: (args: string[]) => void;
  onCancel: () => void;
  onMessage: (role: "output" | "system", content: string) => void;
}

interface TokenConfig {
  name: string;
  symbol: string;
  decimals: string;
  initialSupply: string;
  maxSupply: string;
}

const STEPS = ["name", "symbol", "decimals", "initialSupply", "maxSupply", "confirm"] as const;
type Step = (typeof STEPS)[number];

function deriveSymbol(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9 ]/g, "").trim();
  const words = cleaned.split(/\s+/);
  if (words.length >= 2) {
    return words
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 6);
  }
  return cleaned.toUpperCase().slice(0, 4);
}

function formatNumber(value: string): string {
  const cleaned = value.replace(/,/g, "");
  try {
    return BigInt(cleaned).toLocaleString("en-US");
  } catch {
    return value;
  }
}

function parseSupply(value: string): string {
  return value.replace(/,/g, "").trim();
}

function buildSummaryBox(config: TokenConfig, shortAddr: string): string {
  const lines = [
    "",
    "  +--------------------------------------------+",
    "  |  Token Summary                             |",
    "  |                                            |",
    `  |  Name:            ${config.name.padEnd(24)}|`,
    `  |  Symbol:          ${config.symbol.padEnd(24)}|`,
    `  |  Decimals:        ${config.decimals.padEnd(24)}|`,
    `  |  Initial supply:  ${formatNumber(config.initialSupply).padEnd(24)}|`,
    `  |  Max supply:      ${(config.maxSupply ? formatNumber(config.maxSupply) : "unlimited").padEnd(24)}|`,
    `  |  Creator:         ${shortAddr.padEnd(24)}|`,
    "  |                                            |",
    "  +--------------------------------------------+",
    "",
  ];
  return lines.join("\n");
}

export function TokenLaunchWizard({ walletAddress, onLaunch, onCancel, onMessage }: TokenLaunchWizardProps) {
  const [step, setStep] = useState<Step>("name");
  const [config, setConfig] = useState<TokenConfig>({
    name: "",
    symbol: "",
    decimals: "9",
    initialSupply: "1000000",
    maxSupply: "",
  });
  const [buffer, setBuffer] = useState<EditorBuffer>(() => createEditorState(""));
  const [error, setError] = useState<string | null>(null);

  const shortAddr = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : "unknown";

  // Show the wizard header when it first mounts
  useEffect(() => {
    onMessage("system", "Create a new token on Cowboy\n  Step 1 of 5");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const advance = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      setError(null);

      switch (step) {
        case "name": {
          if (!trimmed) {
            setError("Token name is required");
            return;
          }
          if (trimmed.length > 64) {
            setError("Token name must be 64 characters or less");
            return;
          }
          const sym = deriveSymbol(trimmed);
          setConfig((c) => ({ ...c, name: trimmed, symbol: sym }));
          onMessage("output", `  Token name: ${trimmed}`);
          onMessage("system", "Step 2 of 5");
          setStep("symbol");
          setBuffer(createEditorState(sym));
          return;
        }

        case "symbol": {
          const sym = trimmed || config.symbol;
          if (!sym) {
            setError("Symbol is required");
            return;
          }
          if (sym.length > 10) {
            setError("Symbol must be 10 characters or less");
            return;
          }
          const final = sym.toUpperCase();
          setConfig((c) => ({ ...c, symbol: final }));
          onMessage("output", `  Symbol: ${final}`);
          onMessage("system", "Step 3 of 5");
          setStep("decimals");
          setBuffer(createEditorState("9"));
          return;
        }

        case "decimals": {
          const val = trimmed || "9";
          const num = Number(val);
          if (isNaN(num) || num < 0 || num > 18 || !Number.isInteger(num)) {
            setError("Decimals must be an integer between 0 and 18");
            return;
          }
          setConfig((c) => ({ ...c, decimals: val }));
          onMessage("output", `  Decimals: ${val}`);
          onMessage("system", "Step 4 of 5");
          setStep("initialSupply");
          setBuffer(createEditorState("1000000"));
          return;
        }

        case "initialSupply": {
          const raw = parseSupply(trimmed || "1000000");
          try {
            const val = BigInt(raw);
            if (val < 0n) throw new Error();
          } catch {
            setError("Initial supply must be a non-negative integer");
            return;
          }
          setConfig((c) => ({ ...c, initialSupply: raw }));
          onMessage("output", `  Initial supply: ${formatNumber(raw)}`);
          onMessage("system", "Step 5 of 5");
          setStep("maxSupply");
          setBuffer(createEditorState(""));
          return;
        }

        case "maxSupply": {
          let finalMax = "";
          if (trimmed) {
            const raw = parseSupply(trimmed);
            let val: bigint;
            try {
              val = BigInt(raw);
            } catch {
              setError("Max supply must be a positive integer");
              return;
            }
            if (val <= 0n) {
              setError("Max supply must be a positive integer");
              return;
            }
            if (val < BigInt(config.initialSupply)) {
              setError("Max supply cannot be less than initial supply");
              return;
            }
            finalMax = raw;
          }
          const updatedConfig = { ...config, maxSupply: finalMax };
          setConfig(updatedConfig);
          onMessage("output", `  Max supply: ${finalMax ? formatNumber(finalMax) : "unlimited"}`);
          onMessage("output", buildSummaryBox(updatedConfig, shortAddr));
          setStep("confirm");
          setBuffer(createEditorState(""));
          return;
        }

        case "confirm": {
          const answer = trimmed.toLowerCase();
          if (answer === "n" || answer === "no") {
            onCancel();
            return;
          }
          if (answer === "" || answer === "y" || answer === "yes") {
            const args = [
              "--name", config.name,
              "--symbol", config.symbol,
              "--decimals", config.decimals,
              "--initial-supply", config.initialSupply,
            ];
            if (config.maxSupply) {
              args.push("--max-supply", config.maxSupply);
            }
            onLaunch(args);
            return;
          }
          setError("Type y to confirm or n to cancel");
          return;
        }
      }
    },
    [step, config, onLaunch, onCancel, onMessage, shortAddr]
  );

  const handleSubmit = useCallback(
    (value: string) => {
      advance(value);
    },
    [advance]
  );

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const prompts: Record<Exclude<Step, "confirm">, { label: string; hint: string }> = {
    name: { label: "Token name", hint: "1-64 characters" },
    symbol: { label: "Symbol", hint: `max 10 chars, default: ${config.symbol || "auto"}` },
    decimals: { label: "Decimals", hint: "0-18, default: 9" },
    initialSupply: { label: "Initial supply", hint: "default: 1,000,000" },
    maxSupply: { label: "Max supply", hint: "blank = unlimited" },
  };

  if (step === "confirm") {
    return (
      <Box flexDirection="column">
        <Separator />
        <Box paddingX={1}>
          {error && <Text color="red">{error}  </Text>}
          <Text color="yellow">{"Launch token? [Y/n]: "}</Text>
          <LineEditor
            value={buffer.value}
            cursorOffset={buffer.cursorOffset}
            onChange={setBuffer}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
          />
        </Box>
        <Separator />
        <Box paddingX={1}>
          <Text dimColor>{">> Press Esc to cancel"}</Text>
        </Box>
      </Box>
    );
  }

  const currentPrompt = prompts[step];

  return (
    <Box flexDirection="column">
      <Separator />
      <Box paddingX={1}>
        {error && <Text color="red">{error}  </Text>}
        <Text color="cyan">{currentPrompt.label} <Text dimColor>({currentPrompt.hint})</Text>: </Text>
        <LineEditor
          value={buffer.value}
          cursorOffset={buffer.cursorOffset}
          onChange={setBuffer}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      </Box>
      <Separator />
      <Box paddingX={1}>
        <Text dimColor>{">> Press Esc to cancel"}</Text>
      </Box>
    </Box>
  );
}
