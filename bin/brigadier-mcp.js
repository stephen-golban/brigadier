#!/usr/bin/env node

const { runMcpServer } = await import("../dist/mcp/server.js");

process.exitCode = await runMcpServer();
