# Voices Progress Report

Last updated: April 27, 2026

This document summarizes what has been built so far for Voices, what is already live on 0G Galileo, what was changed during the agent rework, and what still needs polish before the hackathon submission.

## Project Summary

Voices is a style marketplace for turning creator writing styles into iNFT-style assets on 0G. A creator uploads private writing samples, signs an attestation, and mints a style token. A consumer can then buy credits, generate content in that style, and settle credit spend plus creator royalty on-chain.

The current direction is:

- 0G Chain for deployed contracts and on-chain minting/credits/royalties.
- 0G Storage for encrypted samples, profile state, event audit streams, and LangGraph checkpoints.
- 0G Compute for style extraction, voice-matched generation, platform tuning, and agent tool planning.
- LangGraph TypeScript swarm for the three coordinating agents.
- Next.js `/test` page for local end-to-end workflow testing with MetaMask.

## Current Git State

Latest pushed commit:

```text
e0bfaf1 Replace custom agents with LangGraph 0G swarm workflow
```

Recent project commits:

```text
e0bfaf1 Replace custom agents with LangGraph 0G swarm workflow
02eebbb Add and test event-driven 0G agents and live workflow console
b6693f5 Document 0G Compute ledger funding minimum
ac54c4a Fix compute SDK smoke test loading
3cdbbba Ignore local deployment artifacts and fix verify docs
2a274e3 Added 0G iNFT contracts, scripts, and SDK smoke tests
```

The repo has been pushed to:

```text
https://github.com/yashwanth-3000/voices.git
```

## Monorepo Structure

The repo is organized into three packages:

```text
contracts/   Solidity contracts, Hardhat deployment, tests, and scripts
backend/     Fastify API, LangGraph agents, 0G wrappers, smoke tests
frontend/    Next.js test UI for the live workflow
```

Useful root scripts:

```bash
pnpm --filter contracts compile
pnpm --filter contracts test
pnpm --filter contracts deploy:0g
pnpm --filter contracts mint:0g

pnpm --filter backend start:mock
pnpm --filter backend start:0g
pnpm --filter backend typecheck
pnpm --filter backend test
pnpm --filter backend storage:hello
pnpm --filter backend compute:hello

BACKEND_URL=http://127.0.0.1:4317 pnpm --filter frontend exec next dev -p 3000
```

## 0G Galileo Network Setup

The project is configured for 0G Galileo:

```text
Network name: 0G-Galileo-Testnet
Chain ID: 16602
RPC: https://evmrpc-testnet.0g.ai
Currency: 0G
Explorer: https://chainscan-galileo.0g.ai
Faucet: https://faucet.0g.ai
```

The connected development wallet used during deployment:

```text
0xf36Dfefe22515B62da384C91fDD16a0d4412C72e
```

## Deployed Contracts

Contracts were deployed to 0G Galileo on April 26, 2026.

Deployment file:

```text
contracts/deployments/0g-galileo.json
```

Deployed addresses:

```text
StyleRegistry: 0x74b904E4097eEE8233a2202e549983F6598Ea5BD
RoyaltyVault:  0x977254e51EDec8e8840f11F3d30d3a752EED4933
CreditSystem:  0x3e005e11E5420fD7D720F66455B4d303f3Ae4c58
```

Constructor configuration:

```text
StyleRegistry base metadata URI: https://voices.local/metadata/
Credit price: 1000000000000000 wei, equal to 0.001 0G
```

## Solidity Work Completed

### StyleRegistry

File:

```text
contracts/contracts/StyleRegistry.sol
```

What it does:

- ERC-721 style token representing a creator writing style.
- Stores creator address, royalty amount, sample count, language, genres, profile URI, encrypted samples URI, attestation URI, metadata hash, listing status, and total earnings.
- Supports a lightweight ERC-7857-style interface with:
  - `transfer(...)`
  - `clone(...)`
  - `authorizeUsage(...)`
- Stores sealed keys per token owner.
- Emits events for style minting, listing updates, royalty updates, metadata access, usage authorization, and royalty accounting.

Important behavior:

- `mintStyle(...)` is called by the creator wallet, not by the backend pretending to be the creator.
- `styleOf(tokenId)`, `creatorOf(tokenId)`, and `royaltyOf(tokenId)` are used by the backend agents and UI.

### RoyaltyVault

File:

```text
contracts/contracts/RoyaltyVault.sol
```

What it does:

- Receives royalty deposits for creators.
- Tracks:
  - `pending[creator]`
  - `lifetimeEarned[creator]`
  - `lifetimeClaimed[creator]`
- Lets creators claim pending royalties.
- Calls back into `StyleRegistry.recordRoyalty(...)` so style-level earnings are visible.

### CreditSystem

File:

```text
contracts/contracts/CreditSystem.sol
```

What it does:

- Lets consumers buy credits with 0G.
- Lets consumers spend one credit against a style token.
- Atomically sends the style royalty to `RoyaltyVault` during `spendCredit(tokenId)`.
- Tracks lifetime purchased and spent credits.

Why this matters:

- The worst partial-failure case, where a user pays but the creator does not receive royalty, is avoided by using `spendCredit(tokenId)` as the atomic settlement path.

## SDK Smoke Tests Completed

The backend includes two SDK hello-world scripts:

```text
backend/src/storage-hello.ts
backend/src/compute-hello.ts
```

Storage smoke test:

- Encrypts local bytes.
- Uploads through 0G Storage.
- Downloads back.
- Decrypts and verifies the roundtrip.

Compute smoke test:

- Calls 0G Compute through the serving broker or OpenAI-compatible endpoint.
- Performs a chat completion roundtrip.

Important note:

- 0G Compute ledger funding requires more than normal gas-only testing. The README documents that the broker may require `broker.ledger.addLedger(3)`, so a wallet needs at least `3 0G` plus gas before running the broker-backed compute test.

## 0G Agent Skills Added

The official 0G agent skills repo was cloned locally as:

```text
.0g-skills/
```

It is ignored by git, but available locally for SDK implementation guidance.

Relevant skill docs inside it:

```text
.0g-skills/patterns/STORAGE.md
.0g-skills/patterns/COMPUTE.md
.0g-skills/patterns/CHAIN.md
.0g-skills/patterns/NETWORK_CONFIG.md
.0g-skills/patterns/SECURITY.md
.0g-skills/patterns/TESTING.md
```

## Agent Architecture Rework

The first agent implementation used a custom `BaseAgent` plus custom event bus. That has now been removed.

Removed old files:

```text
backend/src/agents/base-agent.ts
backend/src/agents/style-curator.ts
backend/src/agents/content-creator.ts
backend/src/agents/distribution-manager.ts
backend/src/events/event-bus.ts
```

The new implementation uses LangGraph TypeScript and LangGraph Swarm:

```text
backend/src/agents/langgraph/state.ts
backend/src/agents/langgraph/swarm.ts
backend/src/agents/langgraph/zero-g-checkpointer.ts
backend/src/events/event-log.ts
```

## LangGraph Swarm Runtime

The current agent runtime uses:

- `@langchain/langgraph`
- `@langchain/langgraph-swarm`
- `createReactAgent`
- `createSwarm`
- LangGraph `Command` handoffs
- A custom 0G-backed checkpoint saver

The three agents are:

```text
style_curator
content_creator
distribution_mgr
```

They are implemented as ReAct agents with explicit tools. The agents do not directly call each other. Handoff happens through LangGraph state and `Command` objects.

### Style Curator

Main responsibilities:

- Validate creator attestation.
- Reject too-small or too-large sample sets.
- Reject obvious known-author/denylist content.
- Encrypt and store writing samples through the storage wrapper.
- Call 0G Compute to extract a structured style profile.
- Store the style profile in 0G KV.
- Prepare a real `StyleRegistry.mintStyle(...)` transaction intent for the wallet.
- Refine style profiles after feedback events.

Tools:

```text
verify_attestation
encrypt_and_store_samples
extract_style_profile
mint_inft
refine_profile_from_feedback
handoff_to_content_creator
```

### Content Creator

Main responsibilities:

- Check consumer credits through `CreditSystem`.
- Confirm the selected style exists through `StyleRegistry.styleOf`.
- Read the stored style profile from KV.
- Pull a small number of relevant sample excerpts for low-cost conditioning.
- Call 0G Compute to generate a voice-matched draft.
- Write the draft to the consumer log.
- Hand off to Distribution Manager.

Tools:

```text
check_credit_balance
read_style_profile
pull_relevant_samples
generate_with_voice
log_draft
handoff_to_distribution
```

### Distribution Manager

Main responsibilities:

- Tune the draft into X, LinkedIn, and Instagram variants.
- Use one compute call for all target platform variants.
- Recheck credits before settlement.
- Prepare a real `CreditSystem.spendCredit(tokenId)` transaction intent.
- Track pending KeeperHub/frontend wallet confirmation.
- Emit royalty settlement events only after confirmation.
- Handle low-credit events and auto-top-up logic when enabled.

Tools:

```text
tune_for_platform
check_credit_balance
deduct_credit_via_keeper
deposit_royalty_via_keeper
topup_credits_via_keeper
handoff_to_curator
```

## LangGraph State

State file:

```text
backend/src/agents/langgraph/state.ts
```

The state includes:

```text
workflowKind
incomingEvent
requestId
currentStyleId
pendingStyleId
consumerAddress
creatorAddress
prompt
targetPlatforms
draftText
platformVariants
royaltyAmount
attestationVerified
samplesRootHash
storageTxHash
profileKey
styleProfile
selectedSamples
creditBalance
teeVerified
keeperHubWorkflowId
settlementStatus
mintIntent
spendIntent
lastEventType
lastError
```

It also extends LangGraph Swarm state, including message accumulation and active-agent state.

## ZeroGCheckpointSaver

File:

```text
backend/src/agents/langgraph/zero-g-checkpointer.ts
```

This is one of the most important infrastructure pieces for the hackathon story.

What it does:

- Implements LangGraph checkpoint persistence against the project storage wrapper.
- Stores active checkpoints in KV.
- Stores checkpoint history in Log.
- Stores pending writes separately.
- Makes LangGraph state resumable and inspectable.

Storage scheme:

```text
Active checkpoint:
lg:thread:${thread_id}:ns:${ns}:active

Append-only checkpoint history stream:
lg:thread:${thread_id}:ns:${ns}

Pending writes:
lg:thread:${thread_id}:ns:${ns}:pending:${checkpoint_id}
```

Why this matters:

```text
We built a LangGraph checkpoint adapter backed by 0G Storage, so any LangGraph agent can persist full execution state to decentralized storage.
```

This is useful beyond Voices and can later be separated into a standalone package like:

```text
@yourname/langgraph-checkpoint-0g
```

## Event Log and Real-Time UI Streams

File:

```text
backend/src/events/event-log.ts
```

The old event bus was replaced by an event log that is used for auditability and UI streaming, not agent routing.

What it does:

- Stores events in process immediately for fast UI updates.
- Mirrors events to 0G Storage asynchronously.
- Supports request-scoped lookup.
- Supports real-time subscriptions for Server-Sent Events.
- Avoids UI hangs when 0G Storage takes time to sync.

Important event types:

```text
style.uploaded
style.mint.intent.created
style.minted
style.refined
style.failed
agent.activity
generation.requested
generation.drafted
generation.published
generation.failed
settlement.intent.created
feedback.received
credit.purchase.intent.created
credit.purchased
credit.deducted
credit.low
credit.replenished
royalty.settled
```

The `agent.activity` event is what powers the live agent activity panel in the frontend.

## Backend API Surface

File:

```text
backend/src/http/app.ts
```

Implemented routes:

```text
GET  /health
GET  /admin/health
GET  /admin/agents

POST /styles/upload
POST /styles/confirm-mint

GET  /credits/:address
POST /credits/buy-intent
POST /credits/confirm-purchase

POST /generate
POST /feedback
POST /settlement/confirm

GET  /events/:requestId
GET  /events/stream/:requestId
```

Important behavior:

- `/styles/upload` emits `style.uploaded` and starts the Style Curator path.
- `/styles/confirm-mint` confirms the MetaMask mint transaction and emits `style.minted`.
- `/credits/buy-intent` prepares the `buyCredits` transaction for MetaMask.
- `/credits/confirm-purchase` confirms the credit purchase after wallet execution.
- `/generate` starts the Content Creator path.
- `/settlement/confirm` confirms spend credit plus royalty settlement after wallet execution.
- `/events/stream/:requestId` streams events to the frontend in real time.

## Infrastructure Wrappers

### 0G Storage

File:

```text
backend/src/infra/storage.ts
```

Exposes:

```text
kvSet
kvGet
kvDelete
logAppend
logScan
uploadEncrypted
downloadEncrypted
```

Current design:

- Memory mode for cheap local tests.
- 0G mode for live storage.
- Cache file support for local continuity.
- Async mirroring for event logs to avoid blocking UI.

### 0G Compute

File:

```text
backend/src/infra/compute.ts
```

Exposes:

```text
chat
verifyResponse
ensureFunds
```

Modes:

- Mock mode for zero-cost local testing.
- Direct OpenAI-compatible 0G Compute mode when `OG_COMPUTE_API_KEY`, `OG_COMPUTE_SERVICE_URL`, and `OG_COMPUTE_MODEL` are configured.
- Broker mode when using `OG_COMPUTE_PROVIDER_ADDRESS`.

Important implementation detail:

- Broker request headers are generated per request, because 0G Compute headers are single-use.
- Service metadata is cached for 5 minutes.

### 0G Chain

File:

```text
backend/src/infra/chain.ts
```

Responsibilities:

- Typed ethers v6 access to deployed contracts.
- Build transaction intents for MetaMask/frontend signing.
- Read style, creator, royalty, credits, and credit price.
- Avoid pretending the backend can spend from user wallets.

### KeeperHub

File:

```text
backend/src/infra/keeperhub.ts
```

Current behavior:

- Interface-first wrapper.
- If KeeperHub credentials are missing, settlement is marked as pending instead of faking success.
- The UI can still show the real transaction intent for wallet signing.

## Prompt Work Completed

Prompt file:

```text
backend/src/agents/prompts.ts
```

Implemented detailed prompts for:

- Style profile extraction.
- Style profile refinement from feedback.
- Voice-matched draft generation.
- Platform variant tuning.

Prompt requirements added:

- Use structured output tags for style profiles.
- Output only the draft inside `<draft>...</draft>`.
- Avoid copying raw samples into the final output.
- Use 3-5 examples only when useful.
- Keep generation low-cost by limiting excerpts.
- Avoid invented facts, fake precision, and unsupported certainty.
- Platform tuning happens in one call for all target platforms.

Recent quality fix:

- Drafts were leaking meta-instructions like "The voice should stay careful".
- The guard was tightened so generated outputs cannot contain style instructions as content.
- Common user prompt typos are normalized, for example `elon much` or `elon mush` becomes `Elon Musk`.
- Platform variants now avoid unsupported hashtag filler.

## Frontend Test Console

Main files:

```text
frontend/src/app/test/page.tsx
frontend/src/app/test/test-page-client.tsx
frontend/src/app/test/test-page.css
```

The `/test` page now supports:

- MetaMask wallet connection.
- Galileo chain detection.
- Style sample input.
- Attestation message generation.
- Wallet signature capture.
- Upload and profile flow.
- Mint transaction intent display.
- MetaMask mint execution.
- Credit balance refresh.
- Buy credit transaction intent.
- MetaMask credit purchase execution.
- Generation request.
- Platform variant display.
- Spend credit and royalty settlement transaction intent.
- MetaMask settlement execution.
- Feedback submission.
- Live agent activity panel.
- Real-time event log.
- Raw log inspector.

Recent UI fix:

- Clicking a live agent activity row or real-time event row now opens a raw JSON panel on the right side.
- This shows all event payload data, tool names, request IDs, transaction intents, hashes, statuses, and agent metadata.

## What Is Real Right Now

Real on-chain:

- Contracts are deployed on 0G Galileo.
- Mint transaction intents are real `StyleRegistry.mintStyle(...)` calls.
- Credit purchase intents are real `CreditSystem.buyCredits(...)` calls.
- Settlement intents are real `CreditSystem.spendCredit(tokenId)` calls.
- Auto-refill contract logic is implemented and tested, but requires redeploying `CreditSystem` because the current Galileo deployment is older.
- User wallet actions are signed through MetaMask.
- Confirmed mint, credit purchase, and settlement events include tx hashes and explorer URLs.

Real agent architecture:

- LangGraph TypeScript is installed and used.
- `createReactAgent` is used for each agent.
- `createSwarm` is used to compose the agents.
- Handoffs use LangGraph `Command`.
- Agent activity is emitted as structured events.
- Agent state can be checkpointed through the 0G storage wrapper.

Real 0G integration:

- 0G Storage wrapper exists.
- 0G Compute wrapper exists.
- 0G Chain wrapper exists.
- 0G testnet config exists.
- 0G SDK smoke scripts exist.
- 0G agent skills are cloned locally for SDK pattern guidance.

## What Is Still Pending or Needs Polish

Not deployed yet:

- Backend has not been deployed to Railway.
- Frontend has not been deployed.
- The accidental Railway project should remain unused until deployment is intentionally planned.

KeeperHub:

- KeeperHub is now wired around the correct autonomous use case: credit auto-refill.
- The upgraded `CreditSystem` supports pre-funded auto-refill budgets and permissionless `refillFromAllowance(consumer)`.
- The backend has a real KeeperHub Direct Execution client for contract calls.
- The app checks KeeperHub chain support before attempting execution.
- Live `/api/chains` currently does not list 0G Galileo chain `16602`, so the system emits `credit.replenish_failed` instead of faking success.
- The deployed Galileo `CreditSystem` address predates the auto-refill contract upgrade and must be redeployed before the auto-refill UI can work on 0G.

0G Compute cost:

- Live 0G Compute can spend 0G from the compute ledger.
- During development, use deterministic or mock mode when testing UI behavior.
- Use live compute only for final proof and demo-quality generations.

Voice quality:

- The generated voice now follows the uploaded style more carefully than before.
- It still needs more evaluation examples and possibly a side-by-side "style score" panel before demo.
- Better creator seed samples will improve output quality.

Frontend:

- `/test` is functional for workflow testing.
- The final product UI still needs polished pages such as `/create`, `/market`, and `/studio`.
- A live activity panel exists, but it can be improved into a more LangGraph Studio-like timeline.

Checkpointer:

- `ZeroGCheckpointSaver` is implemented and tested locally.
- It should eventually be extracted into its own package/repo for the strongest framework-level prize story.

## Verification Done

The following checks were run during implementation:

```bash
pnpm --filter backend typecheck
pnpm --filter frontend typecheck
pnpm --filter backend test
```

They passed before the latest commit was pushed.

Contract tests also exist:

```bash
pnpm --filter contracts test
```

## How To Run Locally

Install dependencies:

```bash
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install
cp .env.example .env
```

Run cheap mock backend:

```bash
pnpm --filter backend start:mock
```

Run live 0G backend:

```bash
PORT=4317 \
AGENT_STORAGE_MODE=0g \
AGENT_COMPUTE_MODE=0g \
AGENT_CHAIN_MODE=0g \
AGENT_LANGGRAPH_PLANNER_MODE=deterministic \
pnpm --filter backend start
```

Run frontend:

```bash
BACKEND_URL=http://127.0.0.1:4317 pnpm --filter frontend exec next dev -p 3000
```

Open:

```text
http://localhost:3000/test
```

## Recommended Demo Flow

1. Connect MetaMask on 0G Galileo.
2. Paste or use the default writing sample.
3. Sign the attestation.
4. Upload and profile the style.
5. Mint the iNFT on-chain through MetaMask.
6. Buy one credit if needed.
7. Generate content with the minted style ID.
8. Watch live agent activity:
   - Style Curator
   - Content Creator
   - Distribution Manager
9. Click raw log entries to show the full JSON trail.
10. Spend credit and settle royalty through MetaMask.
11. Send feedback and show Style Curator refinement.

## Main Hackathon Narrative

The strongest story is not only "we made an agent marketplace." It is:

```text
Voices built a LangGraph swarm whose execution state is persisted to 0G Storage through a custom ZeroGCheckpointSaver. The app uses 0G Chain for iNFT ownership and royalties, 0G Storage for encrypted style memory and checkpoint history, and 0G Compute for profile extraction and voice generation.
```

This maps well to the 0G prize tracks:

- Agent framework/tooling: the 0G-backed LangGraph checkpointer is reusable infrastructure.
- Autonomous agents/swarms/iNFTs: the Style Curator, Content Creator, and Distribution Manager coordinate through LangGraph state, tool calls, and event logs.
- iNFT innovation: writing style becomes an owned, mintable, royalty-bearing asset.

## Suggested Next Steps

1. Improve the creator seed sample set with 5-10 stronger writing styles.
2. Add a "voice match score" or side-by-side style profile panel to make quality visible.
3. Finish KeeperHub live execution or clearly document pending workflow behavior.
4. Extract `ZeroGCheckpointSaver` into a standalone package/repo.
5. Add `/create`, `/market`, and `/studio` pages for the final demo UI.
6. Record a 3-minute demo emphasizing:
   - on-chain mint,
   - live LangGraph agent activity,
   - 0G checkpointed memory,
   - credit spend and royalty settlement,
   - raw event/checkpoint inspectability.
