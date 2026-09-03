import React from "react";
import { Box, Text } from "ink";
import { VERSION } from "../constants.js";
import type { RunnerPreferences } from "../types.js";
import type { PermissionMode } from "../permissions.js";

interface StatusBarProps {
  validatorUrl: string;
  hasKey: boolean;
  walletAddress: string | null;
  walletBalance: number | null;
  cowboyVersion: string | null;
  runnerPreferences: RunnerPreferences;
  runnerUrl: string | null;
  dashboardUrl: string | null;
  cattleGuardUrl: string | null;
  permissionMode: PermissionMode;
}

export function StatusBar({ validatorUrl, hasKey, walletAddress, walletBalance, cowboyVersion, runnerPreferences, runnerUrl, dashboardUrl, cattleGuardUrl, permissionMode }: StatusBarProps) {
  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : null;
  // Account balances are in base units (1 CBY = 10^9); convert for display.
  const balanceLabel =
    walletBalance != null
      ? `${(walletBalance / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} CBY`
      : null;

  const aiMode = cattleGuardUrl ? "cattle-guard" : runnerUrl ? "direct" : dashboardUrl ? "dashboard" : "off";

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
            {balanceLabel && (
              <>
                {" "}(<Text color="green">{balanceLabel}</Text>)
              </>
            )}
          </>
        )}
        {"  "}|{"  "}
        AI: <Text color={aiMode === "off" ? "red" : "green"}>{aiMode}</Text>
        {"  "}|{"  "}
        Mode: <Text color={permissionMode === "auto" ? "yellow" : "green"}>{permissionMode}</Text>
      </Text>
      <Text dimColor>
        {cowboyVersion && <>cli v{cowboyVersion}{"  "}|{"  "}</>}
        lasso v{VERSION}
      </Text>
    </Box>
  );
}
