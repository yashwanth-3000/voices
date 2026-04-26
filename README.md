# voices

Style marketplace foundation for minting writing styles as iNFT-like NFTs on 0G Galileo.

## Packages

- `contracts` - Solidity contracts, Hardhat deployment, verification, and mint scripts.
- `backend` - 0G Storage and 0G Compute hello-world scripts.
- `frontend` - placeholder package for the app surface.

## 0G Galileo

- Network name: `0G-Galileo-Testnet`
- Chain ID: `16602`
- RPC: `https://evmrpc-testnet.0g.ai`
- Currency: `0G`
- Explorer: `https://chainscan-galileo.0g.ai`
- Faucet: `https://faucet.0g.ai`

## Setup

```bash
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install
cp .env.example .env
```

Fill `PRIVATE_KEY` in `.env` with a funded Galileo test wallet. Do not commit `.env`.

## Contracts

```bash
pnpm --filter contracts compile
pnpm --filter contracts test
pnpm --filter contracts deploy:0g
```

The deploy script writes `contracts/deployments/0g-galileo.json`. After deploy, verify each contract:

```bash
pnpm --filter contracts verify:0g -- <STYLE_REGISTRY_ADDRESS> "https://example.invalid/metadata/"
pnpm --filter contracts verify:0g -- <ROYALTY_VAULT_ADDRESS>
pnpm --filter contracts verify:0g -- <CREDIT_SYSTEM_ADDRESS> <ROYALTY_VAULT_ADDRESS> <STYLE_REGISTRY_ADDRESS> 1000000000000000
```

Mint a demo iNFT-style token after deployment:

```bash
pnpm --filter contracts mint:0g
```

## 0G SDK smoke tests

```bash
pnpm --filter backend storage:hello
pnpm --filter backend compute:hello
```

`storage:hello` encrypts bytes locally, uploads them through 0G Storage, downloads the bytes, and decrypts them. `compute:hello` performs a chat completion through a configured 0G Compute provider.
