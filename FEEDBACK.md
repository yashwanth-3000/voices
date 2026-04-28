# KeeperHub Feedback

Project: Voices

Date: April 28, 2026

## Context

Voices is using KeeperHub for a specific autonomous-agent execution path: auto-refilling consumer credits after the Distribution Manager detects a low balance. The consumer pre-funds a refill budget in `CreditSystem`, and the agent asks KeeperHub to call `refillFromAllowance(consumer)` without a MetaMask popup.

## What Worked Well

- The product positioning is clear: KeeperHub is the execution and reliability layer for agents that need to land transactions.
- The Direct Execution API shape is a good fit for permissionless contract functions such as `refillFromAllowance(address)`.
- The MCP docs make the agent-facing story easy to explain: agents can create, execute, and monitor workflows through KeeperHub.
- The public `/api/chains` endpoint is helpful because the app can check network support before attempting execution.

## Specific Issue 1: 0G Galileo Is Not Listed In Supported Chains

The live chains endpoint returned 19 enabled networks, but no 0G Galileo entry and no chain ID `16602`.

This blocks a fully live KeeperHub demo on the same 0G Galileo deployment used by the rest of Voices.

Suggested fix:

- Add 0G Galileo Testnet support with chain ID `16602`.
- Document the exact `network` slug to use in `/api/execute/contract-call`.
- Include the 0G Galileo explorer URL in the chain metadata.

Why it matters:

0G hackathon projects need to show agent execution on 0G, not on a mirror chain. Without native 0G support, builders must either run a parallel Sepolia/Base Sepolia demo or clearly mark KeeperHub as pending for 0G.

## Specific Issue 2: Authentication Docs Conflict

The Direct Execution page says direct execution endpoints require:

```text
X-API-Key: keeper_...
```

The Authentication page says programmatic API access uses:

```text
Authorization: Bearer kh_your_api_key
```

The prefixes also differ in the examples: `keeper_...` versus `kh_...`.

Suggested fix:

- Standardize all Direct Execution examples on one auth method.
- If both headers are accepted, explicitly say both are supported.
- Use the same key prefix in every page.

Why it matters:

Agent integrations are usually written quickly during hackathons. Ambiguous auth docs cost time and create false-negative integration failures.

## Specific Issue 3: Network Slug Is Underdocumented

`/api/chains` returns names like `Base Sepolia`, but `/api/execute/contract-call` examples use slugs like `ethereum`, `base`, and `polygon`.

Suggested fix:

- Include a `slug` or `network` field directly in `/api/chains`.
- Or document the complete mapping from chain ID to accepted network string.

Why it matters:

The chain ID is unambiguous, but the `network` string is what Direct Execution requires. Guessing slugs can break otherwise correct calls.

## Specific Issue 4: Direct Execution Status Semantics Need One More Example

The Direct Execution docs say write functions execute synchronously and return `completed` or `failed`, but there is also a status endpoint for `pending` and `running`.

Suggested fix:

- Add an example showing when a write call returns `pending`.
- Add a recommended polling loop with timeout and retry behavior.

Why it matters:

Agent UIs need to show "workflow created", "running", "confirmed", and "failed" states accurately. A clear example prevents builders from treating a submitted execution as final.

## Feature Request 1: First-Class Check-And-Execute Template For Credit Refill

Voices would benefit from a ready workflow template:

```text
Read credits(consumer)
If credits <= threshold
Call refillFromAllowance(consumer)
Return txHash and new balance
```

This pattern applies broadly to agent wallets, subscription credits, usage credits, and prepaid service balances.

## Feature Request 2: Native MCP Tool Example For A Contract Write

The MCP docs explain how to connect the server, but a complete example for a contract write would help:

```text
execute_contract_call({
  contract_address,
  network,
  function_name,
  function_args,
  abi
})
```

Including one real response body and one status-poll response would make MCP integration faster.

## Current Voices Integration Decision

Because 0G Galileo is not currently listed, Voices does not fake KeeperHub success on Galileo. The app now:

- Implements the real on-chain auto-refill contract method.
- Implements the real KeeperHub Direct Execution client.
- Checks KeeperHub chain support before execution.
- Emits `credit.replenish_failed` with an explicit unsupported-chain reason when KeeperHub cannot execute on 0G Galileo.
- Keeps the path ready for a supported chain or a 0G Galileo listing.

This is intentionally honest. It gives judges a real integration surface to inspect without hiding a mocked KeeperHub workflow.
