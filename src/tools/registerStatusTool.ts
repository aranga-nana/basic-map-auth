import { CopilotClient } from "@github/copilot-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getDailyUsage } from "../usage/dailyUsageStore.js";

type QuotaSnapshot = {
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage: number;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate?: string;
};

function formatPercentage(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) {
    return "unknown";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatQuotaLine(label: string, quota: QuotaSnapshot | undefined) {
  if (!quota) {
    return `${label}: unavailable`;
  }

  return [
    `${label}:`,
    `  used ${quota.usedRequests} of ${quota.entitlementRequests}`,
    `  remaining ${formatPercentage(quota.remainingPercentage)}`,
    `  overage ${quota.overage}`,
    `  reset ${quota.resetDate ?? "unknown"}`,
    `  overage allowed ${quota.overageAllowedWithExhaustedQuota ? "yes" : "no"}`
  ].join("\n");
}

function formatDailyUsage(models: Awaited<ReturnType<typeof getDailyUsage>>["models"]) {
  const modelEntries = Object.entries(models);
  if (modelEntries.length === 0) {
    return "  no local usage recorded yet";
  }

  return modelEntries.map(([model, usage]) => (
    [
      `  ${model}:`,
      `    requests ${usage.requests}`,
      `    input tokens ${usage.inputTokens}`,
      `    output tokens ${usage.outputTokens}`,
      `    cache read tokens ${usage.cacheReadTokens}`,
      `    cache write tokens ${usage.cacheWriteTokens}`
    ].join("\n")
  )).join("\n");
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function registerStatusTool(server: McpServer, githubToken?: string) {
  server.registerTool(
    "get_status",
    {
      title: "Get Status",
      description: "Show server health, Copilot premium quota usage, and today's local usage."
    },
    async () => {
      const dailyUsage = await getDailyUsage();
      const lines = ["System Online"];
      const client = new CopilotClient({ githubToken });

      try {
        await client.start();
        const quota = await client.rpc.account.getQuota();
        const premiumInteractions = quota.quotaSnapshots.premium_interactions as QuotaSnapshot | undefined;
        const chatQuota = quota.quotaSnapshots.chat as QuotaSnapshot | undefined;

        lines.push("");
        lines.push("Copilot quota period usage");
        lines.push(formatQuotaLine("premium interactions", premiumInteractions));
        lines.push(formatQuotaLine("chat", chatQuota));
      } catch (error) {
        lines.push("");
        lines.push(`Copilot quota period usage: unavailable (${errorMessage(error)})`);
      } finally {
        await client.stop().catch(() => undefined);
      }

      lines.push("");
      lines.push(`Server-observed usage for ${dailyUsage.date}`);
      lines.push(`  premium requests ${dailyUsage.premiumRequests}`);
      lines.push(formatDailyUsage(dailyUsage.models));

      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    }
  );
}