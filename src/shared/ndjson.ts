export interface NdjsonOptions<T = unknown> {
  /** Called once for every stream chunk, including chunks without a full line. */
  readonly onActivity?: () => void;
  /** Validates or transforms each parsed JSON value before it is emitted. */
  readonly validate?: (value: unknown, lineNumber: number) => T;
  /** Prefix used when a line cannot be parsed as JSON. */
  readonly parseErrorContext?: string;
}

/**
 * Splits NDJSON only at LF bytes. U+2028 remains ordinary JSON content, and
 * TextDecoder's streaming mode preserves partial UTF-8 sequences.
 */
export async function* readNdjson<T = unknown>(
  stream: ReadableStream<Uint8Array>,
  options: NdjsonOptions<T> = {},
): AsyncGenerator<T> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let lineNumber = 0;

  for await (const chunk of stream) {
    options.onActivity?.();
    buffered += decoder.decode(chunk, { stream: true });

    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        break;
      }

      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      lineNumber += 1;
      if (line.length > 0) {
        yield parseLine(line, lineNumber, options);
      }
    }
  }

  buffered += decoder.decode();
  const finalLine = buffered.replace(/\r$/, "");
  if (finalLine.length > 0) {
    lineNumber += 1;
    yield parseLine(finalLine, lineNumber, options);
  }
}

/** Consumes the shared generator for callback-oriented callers. */
export async function consumeNdjson<T>(
  stream: ReadableStream<Uint8Array>,
  onRecord: (record: T) => void,
  options: NdjsonOptions<T>,
): Promise<void> {
  for await (const record of readNdjson(stream, options)) {
    onRecord(record);
  }
}

function parseLine<T>(
  line: string,
  lineNumber: number,
  options: NdjsonOptions<T>,
): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    const context = options.parseErrorContext ?? "Invalid JSON";
    throw new Error(`${context} on NDJSON line ${lineNumber}`, {
      cause: error,
    });
  }

  return options.validate === undefined
    ? (value as T)
    : options.validate(value, lineNumber);
}
