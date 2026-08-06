export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown = undefined;

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.#error !== undefined) {
      return Promise.reject(this.#error);
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  push(value: T): void {
    if (this.#closed || this.#error !== undefined) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#values.push(value);
    } else {
      waiter.resolve({ done: false, value });
    }
  }

  close(): void {
    if (this.#closed || this.#error !== undefined) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.#closed || this.#error !== undefined) {
      return;
    }
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}
