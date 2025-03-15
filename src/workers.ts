import type {
    WorkerCall, WorkerCallSuccess, WorkerCallError, WorkerConstructor, WorkerObject,
} from './protocol.js';

/**
 * Creates a ref-counted Web Worker definition.
 *
 * The worker module should follow a specific communication protocol,
 * defined by `@reactodia/workspace/worker-protocol` module.
 *
 * @param workerFactory callback to construct a Worker instance on demand
 * @param constructorArgs constructor arguments to initialize the worker
 * with its connected class constructor before any other calls
 *
 * @example
 * ```ts
 * const calcWorker = refCountedWorker<typeof Calculator>(
 *   () => new Worker(new URL('./calc-worker.js', import.meta.url)),
 *   [{ calcPrecision: 2 }]
 * );
 * ...
 *
 * // Get a worker proxy instance
 * const calculator = calcWorker.acquire();
 * // Call a worker method
 * const sum = await calculator.add(2, 3);
 * // Release the worker when its no longer needed
 * calcWorker.release();
 * ```
 */
export function refCountedWorker<T extends { new (...args: any): any }>(
    workerFactory: () => Worker,
    constructorArgs: ConstructorParameters<T>
): RefCountedWorker<WorkerObject<InstanceType<T>>> {
    return new LazyRefCountedWorker<InstanceType<T>>(
        workerFactory,
        constructorArgs
    );
}

/**
 * Represents an opaque ref-counted Web Worker definition
 * created by {@link defineWorker}.
 *
 * @see {@link defineWorker}
 */
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

class LazyRefCountedWorker<T extends WorkerConstructor<unknown[], unknown>>
    implements RefCountedWorker<WorkerObject<T>>
{
    private readonly _factory: () => Worker;
    private readonly _workerArguments: ConstructorParameters<T>;

    private _instance: LazyWorkerProxy<WorkerObject<T>> | undefined;
    private _refCount = 0;

    constructor(
        workerFactory: () => Worker,
        workerArguments: ConstructorParameters<T>
    ) {
        this._factory = workerFactory;
        this._workerArguments = workerArguments;
    }

    private ensureInstance(): LazyWorkerProxy<WorkerObject<T>> {
        if (!this._instance) {
            this._instance = new LazyWorkerProxy(this._factory, this._workerArguments);
        }
        return this._instance;
    }

    getState(): 'disconnected' | 'blocked' | 'ready' | 'connecting' | 'connected' {
        return this._instance ? this._instance.getState() : 'disconnected';
    }

    getProxy(): WorkerObject<T> {
        return this.ensureInstance().proxy;
    }

    acquire(): WorkerObject<T> {
        const instance = this.ensureInstance();
        this._refCount++;
        if (this._refCount > 0) {
            instance.ready();
        }
        return instance.proxy;
    }

    release(): void {
        if (this._instance) {
            this._refCount--;
            if (this._refCount <= 0) {
                this._instance.disconnect();
            }
        }
    }
}

interface LazyWorkerProxyInitialState {
    readonly request: Promise<ConnectionForCall>;
    readonly resolve: (connection: ConnectionForCall) => void;
    readonly reject: (error: unknown) => void;
    readonly controller: AbortController;
}

interface LazyWorkerProxyDisconnectedState {
    readonly type: 'disconnected';
}

interface LazyWorkerProxyBlockedState extends LazyWorkerProxyInitialState {
    readonly type: 'blocked';
}

interface LazyWorkerProxyReadyState extends LazyWorkerProxyInitialState {
    readonly type: 'ready';
}

interface LazyWorkerProxyConnectingState {
    readonly type: 'connecting';
    readonly request: Promise<ConnectionForCall>;
    readonly controller: AbortController;
}

interface LazyWorkerProxyConnectedState {
    readonly type: 'connected';
    readonly connection: WorkerConnection;
    readonly controller: AbortController;
}

type ConnectionForCall = readonly [WorkerConnection, AbortSignal];
type LazyWorkerProxyMethod = (...args: unknown[]) => Promise<unknown>;

class LazyWorkerProxy<T> {
    private static readonly PROXY_OWNER = Symbol('LazyWorkerProxy.owner');

    private connectionState:
        | LazyWorkerProxyDisconnectedState
        | LazyWorkerProxyBlockedState
        | LazyWorkerProxyReadyState
        | LazyWorkerProxyConnectingState
        | LazyWorkerProxyConnectedState;
    private readonly methods = new Map<string, LazyWorkerProxyMethod>();

    readonly proxy: T;

    constructor(
        private readonly workerFactory: () => Worker,
        private readonly constructorArgs: unknown[]
    ) {
        this.connectionState = {type: 'disconnected'};
        const proxyTarget = {
            [LazyWorkerProxy.PROXY_OWNER]: this,
        };
        this.proxy = new Proxy(proxyTarget, {
            get: (target, property) => {
                if (typeof property !== 'string') {
                    return undefined;
                }
                const owner = target[LazyWorkerProxy.PROXY_OWNER];
                return owner.getMethod(property);
            }
        }) as T;
    }

    getState(): typeof this.connectionState['type'] {
        return this.connectionState.type;
    }

    private static makeBlockedState(): LazyWorkerProxyBlockedState {
        let resolve!: (connection: ConnectionForCall) => void;
        let reject!: (error: unknown) => void;
        const request = new Promise<ConnectionForCall>((doResolve, doReject) => {
            resolve = doResolve;
            reject = doReject;
        });
        return {
            type: 'blocked',
            request,
            resolve,
            reject,
            controller: new AbortController(),
        };
    }

    private getMethod(methodName: string): LazyWorkerProxyMethod {
        let method = this.methods.get(methodName);
        if (!method) {
            method = async (...args: unknown[]): Promise<unknown> => {
                const [connection, signal] = await this.tryConnect();
                return connection.call(methodName, args, {signal});
            };
        }
        return method;
    }

    private async tryConnect(): Promise<readonly [WorkerConnection, AbortSignal]> {
        switch (this.connectionState.type) {
            case 'disconnected': {
                this.connectionState = LazyWorkerProxy.makeBlockedState();
                const {request} = this.connectionState;
                return request;
            }
            case 'blocked': {
                const {request} = this.connectionState;
                return request;
            }
            case 'ready': {
                const {request, controller, resolve, reject} = this.connectionState;
                this.connect(this.connectionState)
                    .then(
                        ([connection, signal]) => {
                            this.connectionState = {
                                type: 'connected',
                                connection,
                                controller,
                            };
                            resolve([connection, signal]);
                        },
                        (err) => reject(err),
                    );
                this.connectionState = {type: 'connecting', request, controller};
                return request;
            }
            case 'connecting': {
                const {request} = this.connectionState;
                return request;
            }
            case 'connected': {
                const {connection, controller} = this.connectionState;
                return Promise.resolve([connection, controller.signal] as const);
            }
        }
    }

    private async connect(
        state: LazyWorkerProxyReadyState
    ): Promise<ConnectionForCall> {
        const {controller} = state;
        controller.signal.throwIfAborted();
        const {workerFactory, constructorArgs} = this;
        const rawConnection = new WorkerConnection(workerFactory());
        await rawConnection.call('constructor', constructorArgs, {signal: controller.signal});
        if (controller.signal.aborted) {
            rawConnection.dispose();
            controller.signal.throwIfAborted();
        }
        return [rawConnection, controller.signal] as const;
    }

    ready(): void {
        switch (this.connectionState.type) {
            case 'disconnected': {
                this.connectionState = {
                    ...LazyWorkerProxy.makeBlockedState(),
                    type: 'ready',
                };
                break;
            }
            case 'blocked': {
                this.connectionState = {
                    ...this.connectionState,
                    type: 'ready',
                };
                this.tryConnect().catch(() => {/* ignore */});
                break;
            }
        }
    }

    disconnect(): void {
        switch (this.connectionState.type) {
            case 'disconnected': {
                /* nothing */
                break;
            }
            case 'blocked':
            case 'ready':
            case 'connecting': {
                const {controller} = this.connectionState;
                controller.abort();
                this.connectionState = {type: 'disconnected'};
                break;
            }
            case 'connected': {
                const {connection, controller} = this.connectionState;
                controller.abort();
                connection.dispose();
                this.connectionState = {type: 'disconnected'};
                break;
            }
        }
    }
}

class WorkerConnection {
    private readonly worker: Worker;
    private readonly requests = new Map<number, WorkerRequest>();
    private nextCallId = 1;

    constructor(worker: Worker) {
        this.worker = worker;
        this.worker.addEventListener('message', this.onMessage);
        this.worker.addEventListener('error', this.onError);
    }

    call(
        method: string,
        args: readonly unknown[],
        options?: { signal?: AbortSignal }
    ): Promise<unknown> {
        const id = this.nextCallId++;
        const promise = new Promise<unknown>((resolve, reject) => {
            this.requests.set(id, {resolve, reject});
        });
        const call: WorkerCall = {type: 'call', id, method, args};
        this.worker.postMessage(call);
        return promise;
    }

    private onMessage = (e: MessageEvent) => {
        type ResponseMessage = WorkerCallSuccess | WorkerCallError
        const message = e.data as ResponseMessage;
        const request = this.requests.get(message.id);
        if (request) {
            this.requests.delete(message.id);

            switch (message.type) {
                case 'success': {
                    request.resolve(message.result);
                    break;
                }
                case 'error': {
                    request.reject(message.error);
                    break;
                }
                default: {
                    console.warn(
                        `Unexpected worker response type: ${(message as ResponseMessage).type}`
                    );
                    break;
                }
            }
        }
    };

    private onError = (e: ErrorEvent) => {
        const activeRequests = Array.from(this.requests.values());
        this.requests.clear();
        for (const request of activeRequests) {
            request.reject(e);
        }
    };

    dispose() {
        this.worker.removeEventListener('message', this.onMessage);
        this.worker.removeEventListener('error', this.onError);
        this.worker.terminate();
    }
}

interface WorkerRequest {
    readonly resolve: (result: unknown) => void;
    readonly reject: (err: unknown) => void;
}
