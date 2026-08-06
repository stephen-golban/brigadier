import { describe, expect, test } from "bun:test";
import { consumeNdjson, readNdjson } from "../src/shared/ndjson.ts";

const encoder = new TextEncoder();

describe("shared NDJSON splitter", () => {
  test("preserves LF-only records across every possible byte split", async () => {
    const expected = [
      { text: "line\u2028separator", emoji: "🙂" },
      { final: true },
    ];
    const fixture = `${JSON.stringify(expected[0])}\r\n\r\n${JSON.stringify(
      expected[1],
    )}`;
    const bytes = encoder.encode(fixture);

    for (let split = 0; split <= bytes.length; split += 1) {
      let activityCount = 0;
      const records = await collect(
        readNdjson(
          streamFromChunks([bytes.subarray(0, split), bytes.subarray(split)]),
          { onActivity: () => (activityCount += 1) },
        ),
      );

      expect(records).toEqual(expected);
      expect(activityCount).toBe(2);
    }
  });

  test("reassembles a multi-byte UTF-8 sequence split inside the code point", async () => {
    const bytes = encoder.encode('{"value":"🙂"}\n');
    const emojiStart = findBytes(bytes, encoder.encode("🙂"));
    const split = emojiStart + 2;

    expect(
      await collect(
        readNdjson(
          streamFromChunks([bytes.subarray(0, split), bytes.subarray(split)]),
        ),
      ),
    ).toEqual([{ value: "🙂" }]);
  });

  test("adds caller context and the physical line number to parse errors", async () => {
    let thrown: unknown;
    try {
      await collect(
        readNdjson(streamFromText('{"ok":true}\n\n{"broken":'), {
          parseErrorContext: "Fixture parser received invalid JSON",
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "Fixture parser received invalid JSON on NDJSON line 3",
    );
    expect((thrown as Error).cause).toBeInstanceOf(SyntaxError);
  });

  test("supports callback consumption with caller-supplied validation", async () => {
    const records: JsonObject[] = [];
    await consumeNdjson(
      streamFromText('{"id":1}\n{"id":2}\n'),
      (record) => {
        records.push(record);
      },
      {
        validate: requireObject,
      },
    );

    expect(records).toEqual([{ id: 1 }, { id: 2 }]);
    await expect(
      consumeNdjson(streamFromText("[]\n"), () => {}, {
        validate: requireObject,
      }),
    ).rejects.toThrow("Expected an object on NDJSON line 1");
  });

  test("rejects malformed UTF-8 instead of replacing bytes", async () => {
    await expect(
      collect(readNdjson(streamFromChunks([new Uint8Array([0xff, 0x0a])]))),
    ).rejects.toThrow();
  });
});

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, lineNumber: number): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected an object on NDJSON line ${lineNumber}`);
  }
  return value as JsonObject;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return streamFromChunks([encoder.encode(text)]);
}

function streamFromChunks(
  chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((byte, offset) => haystack[index + offset] === byte)) {
      return index;
    }
  }
  throw new Error("byte sequence not found");
}
