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

## Verifiable trail

Every backend workflow can now be inspected through a proof endpoint:

```bash
GET /proof/:requestId
GET /proof/:requestId    # with Accept: text/html for a browser-readable page
GET /storage/blob?rootHash=<AGENT_BRAIN_ROOT>
GET /admin/health
```

After running `/styles/upload`, `/generate`, or the smoke script, paste the returned `requestId` into `/proof/:requestId`. The response includes the agent trail, AgentBrain manifest root, encrypted sample/profile roots, compute call metadata, checkpoint keys, receipt verifications, contract addresses, and explorer links.

For a full local proof pass:

```bash
pnpm --filter backend smoke:agents
pnpm --filter backend start:mock
```

Then open `/proof/<requestId>` from the smoke output or live UI event stream.

## Agent architecture

The backend uses LangGraph for the upload/mint/proof lifecycle, then hands chatbot generation to a CrewAI runtime:

- `style_curator` uses explicit ReAct tools: `verify_attestation`, `encrypt_and_store_samples`, `extract_style_profile`, `build_and_upload_agent_brain`, `mint_inft`, `refine_profile_from_feedback`, and `handoff_to_content_creator`.
- `content_creator` uses explicit ReAct tools: `check_credit_balance`, `read_style_profile`, `pull_relevant_samples`, `generate_with_voice`, `log_draft`, and `handoff_to_distribution`. The `generate_with_voice` tool starts the Python CrewAI runner.
- `distribution_mgr` uses explicit ReAct tools: `tune_for_platform`, `check_credit_balance`, `deduct_credit_via_keeper`, `deposit_royalty_via_keeper`, `topup_credits_via_keeper`, and `handoff_to_curator`.

The CrewAI generation runner has three agents:

- `Voice Context Agent` reads the StyleRegistry evidence, AgentBrain manifest, profile KV, selected sample excerpts, and recent memory logs that the backend loaded from 0G. It builds a runtime voice packet from stored evidence only.
- `Style Writer Agent` takes the user prompt plus that runtime packet and generates the draft through the backend's 0G Compute bridge.
- `Voice Critic + Memory Agent` compares the draft against the packet, asks for one focused revision when the style fit is weak, and returns critique, feedback, and learned preferences for 0G Log/KV.

CrewAI communicates with Node over JSONL. Each CrewAI agent emits `agent.activity` records, so `/events/stream/:requestId` shows which agent is working, what it read, and what it produced. The Node bridge keeps the same `AgentCompute` path, so live runs still use 0G Compute while local tests can use mock compute.

Install the Python runtime when you want the real CrewAI package:

```bash
python3 -m pip install -r backend/crewai_runtime/requirements.txt
```

LangGraph state is persisted through `ZeroGCheckpointSaver`, a custom checkpointer backed by the same 0G Storage-style KV and Log wrapper the rest of the backend uses. KV stores the active checkpoint per thread, while Log stores append-only checkpoint history for replay and debugging.

The old custom `BaseAgent` and event-bus routing layer has been removed. Event storage remains only as an audit/UI stream; agent routing now happens inside the LangGraph swarm and its `Command` handoffs.

The checkpointer is intentionally separable as `@yourname/langgraph-checkpoint-0g`: an MIT-style LangGraph checkpoint adapter backed by 0G Storage so any LangGraph app can persist resumable, inspectable agent state to 0G.

Local tests use a deterministic low-cost planner with mock compute. In live 0G compute mode, the ReAct planner uses 0G Compute for tool selection by default. To force the low-cost deterministic planner during development, set:

```bash
AGENT_LANGGRAPH_PLANNER_MODE=deterministic
```

## AgentBrain iNFT model

Each minted Voices style gets a fresh 256-bit content key. That key encrypts the creator samples, structured style profile, and future memory stream. The public iNFT reference points to an AgentBrain manifest on 0G Storage, while `StyleRegistry.sealedKeyOf(tokenId, owner)` stores the owner-wrapped content key.

The AgentBrain manifest is intentionally not secret. It is the audit bundle that points to encrypted material:

- encrypted sample root and 0G storage transaction
- encrypted profile root, KV profile key, and refinement count
- memory log stream for feedback/refinement history
- compute provider/model/chat id evidence when available
- content key hash and wrapping mode

When the creator signs the ownership attestation, Voices recovers the EVM public key and uses a simplified ECIES-style secp256k1 wrapper for the content key. If a public key is unavailable, the backend falls back to an explicitly marked `address-derived-demo` wrapper so the demo remains runnable; production transfer re-wrapping should use a TEE/ZKP oracle.

## 0G integration depth

- 0G Storage: encrypted samples, encrypted style profiles, AgentBrain manifests, KV state, Log history, and LangGraph checkpoints.
- 0G Compute: style extraction, generation, platform tuning, profile refinement, and optional ReAct planning. Broker mode surfaces provider address, chat id, token usage, duration, and TEE verification result when the provider returns one.
- 0G Chain: StyleRegistry, CreditSystem, and RoyaltyVault transaction intents; confirmation endpoints now verify receipts and decoded events before emitting confirmed backend events.
- 0G iNFT: ERC-7857-inspired encrypted metadata, per-token sealed keys, owner-scoped access, dynamic memory/refinement, and AgentBrain manifests stored on 0G.

Use `/admin/health` to confirm the demo is in live mode. For the prize demo, the expected modes are:

```json
{
  "storage": "0g",
  "compute": "0g",
  "compute_path": "broker",
  "chain": "0g",
  "checkpoint_flush": "0g",
  "planner": "0g"
}
```

## Honest limitations

- Voices implements an ERC-7857-inspired data model and lifecycle, not full production ERC-7857 proof verification.
- Transfer/clone proof semantics are not verified by a TEE or ZKP oracle in this hackathon build. The contract requires proof bytes, but the proof semantics are a documented next step.
- Per-token key wrapping is real per-style key material, but the fallback `address-derived-demo` mode is only for hackathon/demo continuity. For production, require wallet public-key attestation or oracle-assisted re-wrapping.
- Receipt verification depends on live 0G RPC access and deployed contract addresses. Mock mode returns deterministic mock receipts for local tests.

Useful local checks:

```bash
pnpm --filter backend typecheck
pnpm --filter backend test
pnpm --filter backend start:mock
```
