import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FastStatsClient } from "./api/client";
import { loadConfig } from "./config";
import { log } from "./log";
import { withPortableToolSchemas } from "./schema";
import guide from "./resources/guide.md";
import { FastStatsService } from "./service";
import { registerTools } from "./tools/index";
import { version as VERSION } from "../package.json";

async function main() {
  const config = loadConfig();
  const svc = new FastStatsService(new FastStatsClient(config), config.defaultProject);

  const server = new McpServer(
    { name: "faststats", version: VERSION },
    {
      instructions:
        "Design, validate and publish FastStats charts. Start with get_project_context, read get_guide once, " +
        "preview every spec with preview_chart, and only then create. Never delete without the user's explicit approval.",
    },
  );

  registerTools(server, svc, { readOnly: config.readOnly });
  server.registerResource(
    "guide",
    "faststats://guide",
    { title: "FastStats chart design guide", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide }] }),
  );

  await server.connect(withPortableToolSchemas(new StdioServerTransport()));
  log.info(`ready (v${VERSION}${config.readOnly ? ", read-only" : ""}${config.defaultProject ? `, default project ${config.defaultProject}` : ""})`);
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
