export class ReplicaQueryGate {
  #activeQueries = 0
  #waiters: Array<() => void> = []
  #applying: Promise<void> = Promise.resolve()

  async runQuery<T>(operation: () => Promise<T>): Promise<T> {
    this.#activeQueries += 1
    try {
      return await operation()
    } finally {
      this.#activeQueries -= 1
      if (this.#activeQueries === 0) this.releaseWaiters()
    }
  }

  async runApply<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#applying.then(async () => {
      await this.waitForIdle()
      return await operation()
    })
    this.#applying = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  private async waitForIdle(): Promise<void> {
    if (this.#activeQueries === 0) return
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
    })
  }

  private releaseWaiters(): void {
    const waiters = this.#waiters.splice(0)
    for (const waiter of waiters) waiter()
  }
}
