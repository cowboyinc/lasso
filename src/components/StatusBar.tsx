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
}

export function StatusBar({ validatorUrl, hasKey, walletAddress, cowboyVersion, runnerPreferences }: StatusBarProps) {
  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : null;
  const shortRunner = (value: string | null) =>
    value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "auto";

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
        AI: <Text color="magenta">P {shortRunner(runnerPreferences.primaryRunner)}</Text>
        {" / "}
        <Text color="magenta">H {shortRunner(runnerPreferences.helperRunner)}</Text>
      </Text>
      <Text dimColor>
        {cowboyVersion && <>cli v{cowboyVersion}{"  "}|{"  "}</>}
        lasso v{VERSION}
      </Text>
    </Box>
  );
}
