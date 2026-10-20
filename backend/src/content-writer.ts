// Serializes all content.json read-modify-write operations so the operator's
// PUT /content and the capture-agent source projection never interleave (which
// could drop one writer's changes or tear the file). A simple promise-chain
// mutex — every content write awaits the previous one.

let chain: Promise<unknown> = Promise.resolve();

export function withContentLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of this op's success/failure.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
