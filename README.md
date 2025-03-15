# Reactodia Worker Proxy [![npm version](https://badge.fury.io/js/@reactodia%2Fworker-proxy.svg)](https://badge.fury.io/js/@reactodia%2Fworker-proxy)

`@reactodia/worker-proxy` is a TypeScript/JavaScript library for the browser that makes it easy to run background tasks with dedicated [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Worker) with automatic connection lifecycle and transparently mapped worker logic via [Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy) objects.

## Installation

Install with:
```sh
npm install --save @reactodia/worker-proxy
```

## Quick example

`calc.worker.ts` module:
```ts
import { connectWorker } from '@reactodia/worker-proxy/protocol';

// Define a class with methods which return Promise
// with results to the worker caller side:
class Calculator {
    constructor(options: {
        precision: number;
    }) { ... }

    add(a: number, b: number): Promise<number> {
        ...
    }
}

// Setup communication protocol with the worker caller 
connectWorker(Calculator);
```

`using-calc.ts` module:
```ts
import { refCountedWorker } from '@reactodia/worker-proxy';
import type { Calculator } from './calc.worker.ts';

// Create a ref-counted worker definition
const calcWorker = refCountedWorker<typeof Calculator>(
  () => new Worker(
    new URL('./calc.worker.js', import.meta.url)
  ),
  [{ calcPrecision: 2 }]
);

// Get a proxy and connect to the worker
const calculator = calcWorker.acquire();
// Call a worker method
const sum1 = await calculator.add(2, 3);
const sum2 = await calculator.add(10, 20);
// Release the worker when its no longer needed
calcWorker.release();
```

### Using Web Workers from a React component

Although the library does not expose a built-in hook to use workers from a React component to avoid dependencies, it should be trivial to define a simple hook like this:

```ts
import type { RefCountedWorker } from '@reactodia/worker-proxy';

function useWorker<T>(worker: RefCountedWorker<T>): T {
    React.useEffect(() => {
        worker.acquire();
        return () => worker.release();
    }, [worker]);
    return worker.getProxy();
}
```

Then it can be used in a component this way:

```ts
import { refCountedWorker } from '@reactodia/worker-proxy';
import type { Calculator } from './calc.worker.ts';

const CalcWorker = refCountedWorker<typeof Calculator>(
  () => new Worker(
    new URL('./calc.worker.js', import.meta.url)
  ),
  [{ calcPrecision: 2 }]
);

function MyComponent() {
    const calculator = useWorker(CalcWorker);
    ...
}
```

## API

The library has the following exports:

### Main entry point `@reactodia/worker-proxy`

#### `refCountedWorker<T>(factory, constructorArgs)` function

Creates a ref-counted [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Worker) definition which automatically manages the lifecycle of a worker (create, connect, disconnect) and exposes it behind a [Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy) object implementing the same interface as the mapped worker.

Parameters:
* `factory`: `() => Worker` - callback to construct a Worker instance on demand
* `constructorArgs`: `ConstructorParameters<T>` - constructor arguments to initialize the worker with its connected class constructor before any other calls

Returns: `RefCountedWorker<WorkerObject<InstanceType<T>>>`

#### `RefCountedWorker<T>` interface

```ts
export interface RefCountedWorker<T> {
    /**
     * Returns an lifecycle state of the connected Worker instance.
     */
    getState(): 'disconnected' | 'blocked' | 'ready' | 'connecting' | 'connected';
    /**
     * Returns a cached Proxy instance to transparently call the worker logic.
     *
     * Important: calls to the proxy will be resolved only after `acquire()`
     * method have been called at least once.
     */
    getProxy(): T;
    /**
     * Increments a ref-count and connects to the worker if needed.
     */
    acquire(): T;
    /**
     * Decrements a ref-count and disconnects from the worker if ref-count is zero.
     */
    release(): void;
}
```

### Protocol entry point `@reactodia/worker-proxy/protocol`

#### `connectWorker(factory: WorkerConstructor)` function

Establishes a specific connection protocol between the callee (worker) and external caller (which created a worker via `new Worker(...)` constructor).

The protocol assumes the worker exposes an RPC-like interface via a `class` where every public method returns a `Promise`. This interface is transparently mapped from the caller to the worker via messages.

The communication protocol is defined in terms of messages to be sent with `postMessage()` and received with `onmessage` from withing the worker.
The worker expect the first message to be a `WorkerCall` with `method === "constructor"` to create an instance of the connected class.

Here are the exported definitions for the message types:

```ts
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
```

## License

The library is distributed under MIT license, see [LICENSE](./LICENSE). 
