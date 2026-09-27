import type {
  Consumer,
  LazyPromiseLike,
  NotAnErrorBox,
  SubscriptionLike,
} from "@lazy-promise/interop";
import type { Owner } from "solid-js";
import { getOwner, runWithOwner, untrack } from "solid-js";

export const ownerSymbol = Symbol("owner");

/**
 * The dependency injected by the glue utility: the Solid owner that was current
 * when the glue utility was called.
 */
export interface OwnerDep {
  [ownerSymbol]: Owner | null;
}

const doneResult = { value: undefined, done: true as const };

const resolvedSymbol = Symbol("resolved");
const rejectedSymbol = Symbol("rejected");

class GlueIterator<Value> implements Consumer<Value> {
  subscription: SubscriptionLike | undefined;
  done = false;
  /** Set when the promise settles synchronously inside `subscribe`. */
  syncState: typeof resolvedSymbol | typeof rejectedSymbol | undefined;
  syncResult: unknown;
  resolveNext: ((result: IteratorResult<Value>) => void) | undefined;
  rejectNext: ((error: unknown) => void) | undefined;

  constructor(
    public lazyPromise: LazyPromiseLike<Value, OwnerDep>,
    public owner: Owner | null,
  ) {}

  resolve(value: Value) {
    const resolveNext = this.resolveNext;
    if (!resolveNext) {
      this.syncState = resolvedSymbol;
      this.syncResult = value;
      return;
    }
    this.done = true;
    this.resolveNext = undefined;
    this.rejectNext = undefined;
    resolveNext({ value, done: false });
  }

  reject(error: unknown) {
    const rejectNext = this.rejectNext;
    if (!rejectNext) {
      this.syncState = rejectedSymbol;
      this.syncResult = error;
      return;
    }
    this.done = true;
    this.resolveNext = undefined;
    this.rejectNext = undefined;
    rejectNext(error);
  }

  // Bare (non-promise) results and the synchronously calling thenable below
  // take Solid's synchronous settle paths, which a real promise wouldn't.
  next(): any {
    if (this.done || this.subscription) {
      return doneResult;
    }
    this.subscription = runWithOwner(null, () =>
      untrack(() =>
        this.lazyPromise.subscribe(this, { [ownerSymbol]: this.owner }),
      ),
    );
    if (this.syncState === resolvedSymbol) {
      this.done = true;
      return { value: this.syncResult, done: false };
    }
    if (this.syncState === rejectedSymbol) {
      this.done = true;
      const error = this.syncResult;
      return {
        then: (onResolve: unknown, onReject: (error: unknown) => void) => {
          onReject(error);
        },
      };
    }
    return new Promise((resolve, reject) => {
      this.resolveNext = resolve;
      this.rejectNext = reject;
    });
  }

  return(): any {
    this.done = true;
    // A pending next() promise is deliberately left unsettled: settling it
    // would feed Solid a value or completion for a flight it already closed.
    this.resolveNext = undefined;
    this.rejectNext = undefined;
    this.subscription?.dispose();
    return doneResult;
  }
}

class GlueIterable<Value> implements AsyncIterable<Value> {
  constructor(
    public lazyPromise: LazyPromiseLike<Value, OwnerDep>,
    public owner: Owner | null,
  ) {}

  [Symbol.asyncIterator](): GlueIterator<Value> {
    return new GlueIterator(this.lazyPromise, this.owner);
  }
}

/**
 * Converts a LazyPromise to an AsyncIterable that can be returned from a Solid
 * computation. The LazyPromise is subscribed in an untracked and ownerless
 * context when Solid first pulls the iterator, and unsubscribed when Solid
 * closes it (on re-run or disposal of the computation). The Solid owner is
 * injected as `OwnerDep`.
 */
export const glue = <Value>(
  // Requirements go in a second member so that `Value` is inferred from the
  // first one.
  lazyPromise: LazyPromiseLike<Value, any> &
    LazyPromiseLike<NotAnErrorBox, OwnerDep>,
): AsyncIterable<Value> => new GlueIterable(lazyPromise, getOwner());

export const noop: () => void = () => {};
