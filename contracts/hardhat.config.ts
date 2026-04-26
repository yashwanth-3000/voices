import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const privateKey = process.env.PRIVATE_KEY?.trim();
const accounts = privateKey ? [privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true,
      metadata: {
        bytecodeHash: "none"
      }
    }
  },
  networks: {
    hardhat: {
      chainId: 31337
    },
    ogGalileo: {
      url: process.env.OG_RPC_URL || "https://evmrpc-testnet.0g.ai",
      chainId: Number(process.env.OG_CHAIN_ID || 16602),
      accounts
    }
  },
  etherscan: {
    apiKey: {
      ogGalileo: process.env.CHAINSCAN_API_KEY || "placeholder"
    },
    customChains: [
      {
        network: "ogGalileo",
        chainId: 16602,
        urls: {
          apiURL: "https://chainscan-galileo.0g.ai/open/api",
          browserURL: "https://chainscan-galileo.0g.ai"
        }
      }
    ]
  }
};

export default config;
