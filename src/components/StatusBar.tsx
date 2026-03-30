import React from "react";
import { Box, Text } from "ink";
import { VERSION } from "../constants.js";

interface StatusBarProps {
  validatorUrl: string;
  hasKey: boolean;
  walletAddress: string | null;
  cowboyVersion: string | null;
}

export function StatusBar({ validatorUrl, hasKey, walletAddress, cowboyVersion }: StatusBarProps) {
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
      </Text>
      <Text dimColor>
        {cowboyVersion && <>cli v{cowboyVersion}{"  "}|{"  "}</>}
        lasso v{VERSION}
      </Text>
    </Box>
  );
}
