/**
 * JSON-RPC 2.0 and the Model Context Protocol, hand-rolled.
 *
 * WHY THERE IS NO SDK HERE. brigadier ships with no runtime dependencies —
 * `package.json` has no `dependencies` key and the product is one compiled
 * binary — and that is not a stylistic preference: a Claude Desktop `.mcpb`
 * bundle is a zip the user opens, and a bundle whose server needs an
 * `npm install` before it runs is a bundle that does not run. So the transport
 * is written against the spec instead of against `@modelcontextprotocol/sdk`.
 *
 * The surface a server actually needs is small enough for that to be honest
 * rather than heroic: newline-delimited JSON on stdio, five methods, and the
 * standard error codes. Everything in this file is a pure function of a line of
 * text, which is what lets `test/mcp.test.ts` assert the exact bytes.
 *
 * THE FRAMING IS NEWLINE-DELIMITED JSON, NOT `Content-Length`. That is MCP's
 * stdio transport, and it is the one place people reach for LSP's framing by
 * reflex and produce a server no client can talk to. A message MUST NOT contain
 * an embedded newline, which is free here: `JSON.stringify` escapes every
 * newline inside every string it emits, so a tool whose text output is forty
 * lines long still leaves this file as one line.
 *
 * BATCHING IS REFUSED. JSON-RPC 2.0 allows an array of requests; MCP removed
 * batching in revision 2025-06-18. Accepting it would mean implementing a
 * framing rule the current spec does not have, so an array gets `-32600` with a
 * sentence saying which of the two documents it is failing.
 */

export const JSONRPC_VERSION = "2.0";

/**
 * The revision this server implements. Also the fallback it offers a client
 * that asked for a revision this server does not know.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Revisions this server will speak if the client asks for one by name. Newest
 * first, and `MCP_PROTOCOL_VERSION` is the first member by construction.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

/** The JSON-RPC 2.0 error codes, plus nothing invented. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** A JSON-RPC id: a string, a number, or absent (a notification). */
export type RequestId = string | number | null;

/**
 * What one tool did. `isError` is carried in the RESULT rather than raised as a
 * JSON-RPC error, which is the spec's rule and not an accident: a tool that
 * failed is information the model must be able to read and act on, where a
 * protocol error is a transport fault the model never sees.
 */
export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * A JSON Schema object, as loose as the wire is. The schema is data handed to
 * the client verbatim; nothing in this process validates against it, so giving
 * it a nominal type here would be a promise this file cannot keep.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  handle(args: unknown): Promise<ToolResult>;
}

export interface DispatcherOptions {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly tools: readonly ToolDefinition[];
}

/**
 * Turns one line of input into one line of output, or into null.
 *
 * Null means "write nothing", and it is the correct answer for exactly one
 * thing: a notification. JSON-RPC forbids a response to a message with no id,
 * and a server that answers `notifications/initialized` anyway is a server every
 * strict client disconnects from.
 */
export type Dispatch = (line: string) => Promise<string | null>;

export function createDispatcher(options: DispatcherOptions): Dispatch {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of options.tools) {
    byName.set(tool.name, tool);
  }

  return async (line: string): Promise<string | null> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return null;
    }

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // The engine's own parse message is DELIBERATELY NOT FORWARDED. Bun says
      // `JSON Parse error: Expected '}'` where Node says `Unexpected end of JSON
      // input` for the same bytes, and this server is developed under Bun and
      // shipped to Claude Desktop under Node. A client must not be able to tell
      // which one it is talking to from an error string, and a test must not be
      // asserting one engine's wording as if it were this server's contract.
      return errorLine(null, PARSE_ERROR, "invalid JSON");
    }

    if (Array.isArray(message)) {
      return errorLine(
        null,
        INVALID_REQUEST,
        "batch requests are not supported: MCP removed JSON-RPC batching in revision 2025-06-18",
      );
    }
    const record = asRecord(message);
    if (record === null) {
      return errorLine(
        null,
        INVALID_REQUEST,
        "a JSON-RPC message must be an object",
      );
    }

    const id = readId(record.id);
    const isNotification = record.id === undefined;

    if (record.jsonrpc !== JSONRPC_VERSION) {
      return isNotification
        ? null
        : errorLine(
            id,
            INVALID_REQUEST,
            `jsonrpc must be ${JSON.stringify(JSONRPC_VERSION)}`,
          );
    }
    const method = record.method;
    if (typeof method !== "string") {
      return isNotification
        ? null
        : errorLine(id, INVALID_REQUEST, "method must be a string");
    }

    // Notifications are answered with silence whatever they say. `initialized`
    // is the one every client sends; `notifications/cancelled` is the one every
    // client sends next, and this server has nothing long-running to cancel
    // between lines, so acknowledging either would be the only bug available.
    if (isNotification) {
      return null;
    }

    try {
      return await handleRequest(record, id, method, options, byName);
    } catch (error) {
      // A handler that throws is a defect in this process, not a bad request.
      // It still owes the client a response rather than a dropped line.
      return errorLine(id, INTERNAL_ERROR, describe(error));
    }
  };
}

async function handleRequest(
  record: Readonly<Record<string, unknown>>,
  id: RequestId,
  method: string,
  options: DispatcherOptions,
  byName: ReadonlyMap<string, ToolDefinition>,
): Promise<string> {
  switch (method) {
    case "initialize":
      return resultLine(id, {
        protocolVersion: negotiateVersion(record.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: options.serverName,
          version: options.serverVersion,
        },
      });
    case "ping":
      return resultLine(id, {});
    case "tools/list":
      return resultLine(id, {
        tools: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case "tools/call":
      return await callTool(record.params, id, byName);
    default:
      return errorLine(
        id,
        METHOD_NOT_FOUND,
        `unknown method ${JSON.stringify(method)}`,
      );
  }
}

/**
 * An unknown tool NAME is `-32602`, while a tool that ran and failed is a result
 * with `isError`. The split is the spec's and it matters: the first is the
 * client asking for something that does not exist, which the model must never
 * see as a work product, and the second is an answer.
 */
async function callTool(
  params: unknown,
  id: RequestId,
  byName: ReadonlyMap<string, ToolDefinition>,
): Promise<string> {
  const record = asRecord(params);
  if (record === null) {
    return errorLine(id, INVALID_PARAMS, "params must be an object");
  }
  const name = record.name;
  if (typeof name !== "string") {
    return errorLine(id, INVALID_PARAMS, "params.name must be a string");
  }
  const tool = byName.get(name);
  if (tool === undefined) {
    return errorLine(
      id,
      INVALID_PARAMS,
      `unknown tool ${JSON.stringify(name)}`,
    );
  }

  let outcome: ToolResult;
  try {
    outcome = await tool.handle(record.arguments);
  } catch (error) {
    outcome = { text: `${name} failed: ${describe(error)}`, isError: true };
  }
  return resultLine(id, {
    content: [{ type: "text", text: outcome.text }],
    isError: outcome.isError,
  });
}

/**
 * The client's revision if this server speaks it, and this server's own
 * otherwise. Per the spec the client then either accepts the answer or
 * disconnects; guessing on its behalf is not this server's business.
 */
function negotiateVersion(params: unknown): string {
  const record = asRecord(params);
  const requested = record?.protocolVersion;
  return typeof requested === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

/**
 * Key order is `jsonrpc`, `id`, then `result` — insertion order, which
 * `JSON.stringify` preserves for non-integer-like keys. The tests assert the
 * exact bytes of a response, so the order is part of this file's contract and
 * not an incidental property of how it happens to be written.
 */
function resultLine(id: RequestId, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result });
}

function errorLine(id: RequestId, code: number, message: string): string {
  return JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  });
}

/**
 * Null for anything JSON-RPC does not allow as an id, which is what the spec
 * asks a server to answer with when it could not read one.
 */
function readId(value: unknown): RequestId {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
