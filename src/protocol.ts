export interface WorkerCall {
    readonly type: 'call';
    readonly id: number;
    readonly method: string;
    readonly args: readonly unknown[];
}

export interface WorkerCallSuccess {
    readonly type: 'success';
    readonly id: number;
    readonly result: unknown;
}

export interface WorkerCallError {
    readonly type: 'error';
    readonly id: number;
    readonly error: unknown;
}

export type WorkerConstructor<A extends any[], T> =
    new (...initArgs: A) => WorkerObject<FunctionsOnly<T>>;

export type WorkerObject<T> = {
    [K in keyof T]:
        T[K] extends (...args: infer P) => infer R
            ? (R extends Promise<any> ? T[K] : (...args: P) => Promise<R>)
            : never
};

type FunctionsOnly<T> = Pick<T, {
    [K in keyof T]: T[K] extends Function ? K : never
}[keyof T]>;

/**
 * Establishes a specific connection protocol between the callee (worker) and external
 * caller (which created a worker via `new Worker(...)` constructor).
 *
 * The protocol assumes the worker exposes an RPC-like interface via a `class` where
 * every public method returns a `Promise`. This interface is transparently mapped
 * from the caller to the worker via messages.
 *
 * @example
 * ```ts
 * // calc.worker.ts
 * import { connectWorker } from '@reactodia/worker-proxy/protocol';
 * 
 * class Calculator {
 *     constructor(options: { precision: number }) { ... }
 *     add(a: number, b: number): Promise<number> { ... }
 * }
 *
 * connectWorker(Calculator);
 * 
 * // component.ts
 * const calcWorker = refCountedWorker(
 *   () => new Worker(new URL('./calc.worker.js', import.meta.url)),
 *   { calcPrecision: 2 }
 * );
 * 
 * ...
 * // Get a worker proxy instance
 * const calculator = calcWorker.acquire();
 * // Call a worker method
 * const sum = await calculator.add(2, 3);
 * // Release the worker when its no longer needed
 * calcWorker.release();
 * ```
 */
export function connectWorker<A extends any[], T>(factory: WorkerConstructor<A, T>): void {
    let handler: Record<string, (...args: unknown[]) => Promise<any>>;
    onmessage = async e => {
        const message = e.data as WorkerCall;
        if (message.type === 'call') {
            let response: WorkerCallSuccess | WorkerCallError;
            try {
                if (handler) {
                    const result = await handler[message.method](...message.args);
                    response = {
                        type: 'success',
                        id: message.id,
                        result,
                    };
                } else {
                    if (message.method !== 'constructor') {
                        throw new Error('Cannot call worker method without initializing it first');
                    }
                    handler = new factory(...(message.args as A));
                    response = {
                        type: 'success',
                        id: message.id,
                        result: undefined,
                    };
                }
            } catch (err) {
                response = {
                    type: 'error',
                    id: message.id,
                    error: err,
                };
            }
            postMessage(response);
        }
    };
}
