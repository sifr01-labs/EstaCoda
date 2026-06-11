export type BatchRunnerTask<TTask> = {
  task: TTask;
  index: number;
};

export type BatchRunnerResult<TResult> = {
  results: TResult[];
  maxObservedConcurrency: number;
};

export async function runBoundedBatch<TTask, TResult>(input: {
  tasks: TTask[];
  maxConcurrency: number;
  signal?: AbortSignal;
  runTask: (task: TTask, index: number) => Promise<TResult>;
  skipTask: (task: TTask, index: number, reason: "cancelled") => TResult | Promise<TResult>;
}): Promise<BatchRunnerResult<TResult>> {
  const limit = Math.max(1, Math.min(input.maxConcurrency, input.tasks.length));
  const results: TResult[] = new Array(input.tasks.length);
  let nextIndex = 0;
  let active = 0;
  let maxObservedConcurrency = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (input.signal?.aborted === true) {
        return;
      }

      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.tasks.length) {
        return;
      }

      active += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
      try {
        results[index] = await input.runTask(input.tasks[index]!, index);
      } finally {
        active -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));

  for (let index = 0; index < input.tasks.length; index += 1) {
    if (results[index] === undefined) {
      results[index] = await input.skipTask(input.tasks[index]!, index, "cancelled");
    }
  }

  return {
    results,
    maxObservedConcurrency
  };
}
