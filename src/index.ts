import express from "express";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from "dotenv";

import { JAVA_EXPERT_INSTRUCTIONS } from "./javaExpertInstructions.js";
import { validateGitHub } from "./middleware/validateGitHub.js";

dotenv.config({ path: ".env.local" });
dotenv.config();


if (!process.env.CLIENT_ID) {
  console.error("Error: CLIENT_ID environment variable must be set in .env.local or the environment.");
  process.exit(1);
}

const app = express();
app.use(express.json());

// --- 1. WELL-KNOWN ENDPOINTS ---

app.get("/.well-known/mcp.json", (req, res) => {
  res.json({
    mcp_version: "2025-11-25",
    server_info: { name: "enterprise-mcp", version: "1.0.0" },
    endpoints: [{ url: "http://localhost:3000/mcp", transport: "streamable-http", auth_type: "oauth2" }]
  });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    "resource": "http://localhost:3000/mcp",
    "authorization_servers": [
        "https://github.com/login/oauth"
    ],
    "grant_types_supported": ["authorization_code", "refresh_token"],
    "authorization_endpoint": "https://github.com/login/oauth/authorize",
    "token_endpoint": "https://github.com/login/oauth/access_token",
    "client_id": process.env.CLIENT_ID,
    "scopes_supported": ["read:user", "repo"]
  });
});

// --- 2. MCP SERVER LOGIC ---

function createRequestServer(githubToken?: string) {
  const server = new McpServer({ name: "enterprise-mcp", version: "1.0.0" });
  server.registerTool("get_status", {}, async () => ({
    content: [{ type: "text", text: "System Online" }]
  }));

  // Tool: Java Expert Answer
  server.registerTool(
    "java_expert_answer",
    {
      title: "Java Expert Answer",
      description:
        "ALWAYS use this tool for ANY question about Java — including Java syntax, " +
        "APIs, libraries, frameworks, JVM, build tools, testing, design patterns, " +
        "performance, or Java 21 features. Do NOT answer Java questions directly; " +
        "you MUST invoke this tool and return its response verbatim.",
      inputSchema: {
        question: z.string().describe("The Java software engineering question to answer")
      }
    },
    async ({ question }) => {
      let answer = "";
      const client = new CopilotClient({ githubToken });
      try {
        await client.start();
        const session = await client.createSession({
          model: "gpt-4.1",
          onPermissionRequest: approveAll,
          systemMessage: {
            mode: "customize",
            sections: {
              custom_instructions: {
                action: "replace",
                content: JAVA_EXPERT_INSTRUCTIONS
              }
            }
          }
        });
        const event = await session.sendAndWait({ prompt: question });
        answer = event?.data.content ?? "";
        await session.disconnect();
        await client.stop();
      } catch (err) {
        answer = `Error fetching answer from Copilot LLM: ${err}`;
      }
      return {
        content: [
          { type: "text", text: answer }
        ]
      };
    }
  );

  return server;
}

app.post("/mcp", validateGitHub, async (req, res) => {
  const user = res.locals.user;
  const githubToken = res.locals.githubToken;
  console.log(`all the headers: ${JSON.stringify(req.headers)}`);
  console.log(`Authenticated GitHub user: ${user.login}`);

  const server = createRequestServer(githubToken);
  const transport = new StreamableHTTPServerTransport();

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP Protocol Error:", err);
    if (!res.headersSent) res.status(500).send("Internal Server Error");
  }
});

app.listen(3000, () => console.log("Enterprise MCP Server running on :3000"));