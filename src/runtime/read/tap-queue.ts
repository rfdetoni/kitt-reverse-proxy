export class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private head = 0;
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.items.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *events(): AsyncIterable<T> {
    while (true) {
      if (this.head < this.items.length) {
        const item = this.items[this.head++]!;
        if (this.head === this.items.length) {
          this.items.length = 0;
          this.head = 0;
        } else if (this.head >= 256 && this.head >= this.items.length / 2) {
          this.items.splice(0, this.head);
          this.head = 0;
        }
        yield item;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}
