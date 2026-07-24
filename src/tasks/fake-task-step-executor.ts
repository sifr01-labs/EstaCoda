import type {
  TaskExecutorSettlement,
  TaskStepExecutionInput,
  TaskStepExecutor
} from "./task-step-executor.js";

export type FakeTaskExecutionHandler = (
  input: TaskStepExecutionInput,
  executionNumber: number
) => TaskExecutorSettlement | Promise<TaskExecutorSettlement>;

/** Deterministic executor used by scheduler, fencing, and restart tests. */
export class FakeTaskStepExecutor implements TaskStepExecutor {
  readonly kind = "agent" as const;
  readonly executions: TaskStepExecutionInput[] = [];
  readonly #handler: FakeTaskExecutionHandler;

  constructor(handler: FakeTaskExecutionHandler = () => ({ outcome: "succeeded" })) {
    this.#handler = handler;
  }

  execute(input: TaskStepExecutionInput): Promise<TaskExecutorSettlement> {
    this.executions.push(input);
    return Promise.resolve(this.#handler(input, this.executions.length));
  }
}
