export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    timeoutError: () => Error;
    cancelledError: () => Error;
  },
): Promise<T> {
  if (options.signal?.aborted) throw options.cancelledError();
  const controller = new AbortController();
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (error: Error) => {
    controller.abort(error);
    rejectCancellation(error);
  };
  const onAbort = () => cancel(options.cancelledError());
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => cancel(options.timeoutError()), options.timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), cancellation]);
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
