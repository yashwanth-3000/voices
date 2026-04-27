# voices

Style marketplace foundation for minting writing styles as iNFT-like NFTs on 0G Galileo.

## Packages

- `contracts` - Solidity contracts, Hardhat deployment, verification, and mint scripts.
- `backend` - Fastify API, LangGraph swarm agents, 0G Storage/Compute wrappers, and SDK smoke tests.
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
pnpm --filter contracts verify:0g <STYLE_REGISTRY_ADDRESS> "https://example.invalid/metadata/"
pnpm --filter contracts verify:0g <ROYALTY_VAULT_ADDRESS> <STYLE_REGISTRY_ADDRESS>
pnpm --filter contracts verify:0g <CREDIT_SYSTEM_ADDRESS> <ROYALTY_VAULT_ADDRESS> <STYLE_REGISTRY_ADDRESS> 1000000000000000
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

The 0G Compute broker currently requires more test funds than basic chain/storage work. If the wallet has no Compute ledger yet, the SDK asks for `broker.ledger.addLedger(3)`, so keep at least `3 0G` plus gas available before running the broker-backed compute smoke test.

## Agent architecture

The backend now runs the three Voices specialists as a LangGraph swarm:

- `style_curator` uses explicit ReAct tools: `verify_attestation`, `encrypt_and_store_samples`, `extract_style_profile`, `mint_inft`, `refine_profile_from_feedback`, and `handoff_to_content_creator`.
- `content_creator` uses explicit ReAct tools: `check_credit_balance`, `read_style_profile`, `pull_relevant_samples`, `generate_with_voice`, `log_draft`, and `handoff_to_distribution`.
- `distribution_mgr` uses explicit ReAct tools: `tune_for_platform`, `check_credit_balance`, `deduct_credit_via_keeper`, `deposit_royalty_via_keeper`, `topup_credits_via_keeper`, and `handoff_to_curator`.

LangGraph state is persisted through `ZeroGCheckpointSaver`, a custom checkpointer backed by the same 0G Storage-style KV and Log wrapper the rest of the backend uses. KV stores the active checkpoint per thread, while Log stores append-only checkpoint history for replay and debugging.

The old custom `BaseAgent` and event-bus routing layer has been removed. Event storage remains only as an audit/UI stream; agent routing now happens inside the LangGraph swarm and its `Command` handoffs.

The checkpointer is intentionally separable as `@yourname/langgraph-checkpoint-0g`: an MIT-style LangGraph checkpoint adapter backed by 0G Storage so any LangGraph app can persist resumable, inspectable agent state to 0G.

Local tests use a deterministic low-cost planner with mock compute. In live 0G compute mode, the ReAct planner uses 0G Compute for tool selection by default. To force the low-cost deterministic planner during development, set:

```bash
AGENT_LANGGRAPH_PLANNER_MODE=deterministic
```

Useful local checks:

```bash
pnpm --filter backend typecheck
pnpm --filter backend test
pnpm --filter backend start:mock
```
