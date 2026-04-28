import { KeeperHubClient, KeeperHubResult, TransactionIntent } from "./types.js";

export class KeeperHubRestClient implements KeeperHubClient {
  private readonly apiUrl = process.env.KEEPERHUB_API_URL?.replace(/\/$/, "");
  private readonly apiKey = process.env.KEEPERHUB_API_KEY;

  async executeTransaction(intent: TransactionIntent): Promise<KeeperHubResult> {
    if (!this.apiUrl || !this.apiKey) {
      return {
        status: "pending_keeperhub",
        reason: "KeeperHub credentials are not configured",
        workflowId: `intent:${Buffer.from(intent.description).toString("hex").slice(0, 16)}`
      };
    }

    const response = await fetch(`${this.apiUrl}/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(intent)
    });

    if (!response.ok) {
      return { status: "failed", reason: `${response.status} ${await response.text()}` };
    }

    const data = await response.json();
    return { status: "pending_keeperhub", workflowId: data.workflowId ?? data.id };
  }

  async pollWorkflow(workflowId: string): Promise<KeeperHubResult> {
    if (!this.apiUrl || !this.apiKey || workflowId.startsWith("intent:")) {
      return { status: "pending_keeperhub", workflowId, reason: "KeeperHub polling is not configured" };
    }

    const response = await fetch(`${this.apiUrl}/workflows/${workflowId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` }
    });
    if (!response.ok) {
      return { status: "failed", workflowId, reason: `${response.status} ${await response.text()}` };
    }
    const data = await response.json();
    if (data.status === "confirmed" || data.status === "success") {
      return { status: "confirmed", workflowId, txHash: data.txHash };
    }
    return { status: "pending_keeperhub", workflowId, reason: data.status ?? "pending" };
  }
}

export function createKeeperHubClient(): KeeperHubClient {
  return new KeeperHubRestClient();
}

