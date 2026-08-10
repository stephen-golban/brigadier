/**
 * Hand-rolled TTY prompts over injected streams. Zero dependencies, and no
 * dependency on a real terminal either: every prompt reads from an injected
 * `AsyncIterable` and writes to an injected sink, so the whole flow is
 * scriptable from a test and from a pipe.
 *
 * End of input is never an error. A closed stdin answers every remaining
 * prompt with its default, which is what makes `brigadier init < /dev/null`
 * behave like `brigadier init --yes` instead of hanging.
 */

/** Anything that accepts written text: `process.stdout`, or a test collector. */
export interface OutputStream {
  write(chunk: string): unknown;
}

/** Anything that yields input chunks: `process.stdin`, or a test script. */
export type InputStream = AsyncIterable<string | Uint8Array>;

export interface PromptIo {
  readonly reader: LineReader;
  readonly output: OutputStream;
}

/** Maximum re-asks before a prompt gives up and takes its default. */
const MAX_ATTEMPTS = 3;

/** Splits an async chunk stream into lines without buffering the whole input. */
export class LineReader {
  readonly #iterator: AsyncIterator<string | Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #exhausted = false;

  constructor(input: InputStream) {
    this.#iterator = input[Symbol.asyncIterator]();
  }

  /** Resolves the next line without its terminator, or `null` at end of input. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return stripCarriageReturn(line);
      }
      if (this.#exhausted) {
        if (this.#buffer.length === 0) {
          return null;
        }
        const remainder = this.#buffer;
        this.#buffer = "";
        return stripCarriageReturn(remainder);
      }
      const next = await this.#iterator.next();
      if (next.done === true) {
        this.#exhausted = true;
        continue;
      }
      this.#buffer +=
        typeof next.value === "string"
          ? next.value
          : this.#decoder.decode(next.value, { stream: true });
    }
  }
}

export interface Choice<T> {
  readonly label: string;
  readonly value: T;
  readonly detail?: string;
}

/** A yes/no prompt. Empty input and end of input both take the default. */
export async function confirmPrompt(
  io: PromptIo,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    io.output.write(`\n${question} ${hint} `);
    const line = await io.reader.readLine();
    if (line === null) {
      io.output.write(`${defaultValue ? "y" : "n"}\n`);
      return defaultValue;
    }
    const answer = line.trim().toLowerCase();
    if (answer.length === 0) {
      return defaultValue;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    io.output.write(`  Please answer y or n.\n`);
  }
  io.output.write(`  Taking the default.\n`);
  return defaultValue;
}

/**
 * A single-line free-text prompt. Empty input and end of input take the exact
 * default without trimming or otherwise rewriting user input.
 */
export async function textPrompt(
  io: PromptIo,
  question: string,
  defaultValue: string,
): Promise<string> {
  io.output.write(`\n${question} [${defaultValue}] `);
  const line = await io.reader.readLine();
  if (line === null) {
    io.output.write(`${defaultValue}\n`);
    return defaultValue;
  }
  return line.length === 0 ? defaultValue : line;
}

/**
 * A numbered single-choice prompt. Only the listed choices are reachable, which
 * is how "offer only what the probe found" is enforced at the keyboard.
 *
 * Every prompt consumes exactly one line of input, including a prompt with a
 * single choice. A prompt that answered itself without reading would leave the
 * next prompt eating the line meant for this one, and every answer after it
 * would land on the wrong question.
 */
export async function selectPrompt<T>(
  io: PromptIo,
  question: string,
  choices: readonly Choice<T>[],
  defaultIndex: number,
): Promise<T> {
  const fallbackIndex =
    defaultIndex >= 0 && defaultIndex < choices.length ? defaultIndex : 0;
  const fallback = choices[fallbackIndex];
  if (fallback === undefined) {
    throw new RangeError("selectPrompt requires at least one choice");
  }

  io.output.write(`\n${question}\n`);
  if (choices.length === 1) {
    io.output.write(`  only option: ${fallback.label}\n`);
  }
  for (const [index, choice] of choices.entries()) {
    const marker = index === fallbackIndex ? "*" : " ";
    const detail = choice.detail === undefined ? "" : `  (${choice.detail})`;
    io.output.write(`  ${marker} ${index + 1}) ${choice.label}${detail}\n`);
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    io.output.write(`Choose 1-${choices.length} [${fallbackIndex + 1}] `);
    const line = await io.reader.readLine();
    if (line === null) {
      io.output.write(`${fallbackIndex + 1}\n`);
      return fallback.value;
    }
    const answer = line.trim();
    if (answer.length === 0) {
      return fallback.value;
    }
    if (/^\d+$/.test(answer)) {
      const chosen = choices[Number.parseInt(answer, 10) - 1];
      if (chosen !== undefined) {
        return chosen.value;
      }
    }
    io.output.write(`  Enter a number between 1 and ${choices.length}.\n`);
  }
  io.output.write(`  Taking the default.\n`);
  return fallback.value;
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
