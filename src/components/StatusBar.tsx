import React from "react";
import { Box, Text } from "ink";
import { VERSION } from "../constants.js";
import type { RunnerPreferences } from "../types.js";

interface StatusBarProps {
  validatorUrl: string;
  hasKey: boolean;
  walletAddress: string | null;
  cowboyVersion: string | null;
  runnerPreferences: RunnerPreferences;
  runnerUrl: string | null;
}

export function StatusBar({ validatorUrl, hasKey, walletAddress, cowboyVersion, runnerPreferences, runnerUrl }: StatusBarProps) {
  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : null;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        Network: <Text color="cyan">{validatorUrl}</Text>
        {"  "}|{"  "}
        Key: <Text color={hasKey ? "green" : "red"}>{hasKey ? "set" : "not set"}</Text>
        {shortWallet && (
          <>
            {"  "}|{"  "}
            Wallet: <Text color="yellow">{shortWallet}</Text>
          </>
        )}
        {"  "}|{"  "}
        AI: <Text color={runnerUrl ? "green" : "red"}>{runnerUrl ? "on" : "off"}</Text>
      </Text>
      <Text dimColor>
        {cowboyVersion && <>cli v{cowboyVersion}{"  "}|{"  "}</>}
        lasso v{VERSION}
      </Text>
    </Box>
  );
}
