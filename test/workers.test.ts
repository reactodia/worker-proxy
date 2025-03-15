import { expect, test } from 'vitest';

import { refCountedWorker } from '../src/workers.js';

import type { Calculator } from './calc.worker.js';

function makeCalcWorker() {
    return refCountedWorker<typeof Calculator>(
        () => new Worker(
            new URL('./calc.worker.js', import.meta.url),
            { type: 'module' }
        ),
        [{ precision: 1 }]
    );
}

test('refCountedWorker() basic usage', async () => {
    const calcWorker = makeCalcWorker();
    const calculator = calcWorker.acquire();
    const sum = await calculator.add(1.11, 2.22);
    expect(sum).toBe(3.3);
    calcWorker.release();
});

test('refCountedWorker() release while in the call', async () => {
    const calcWorker = makeCalcWorker();
    const calculator = calcWorker.acquire();
    const sumPromise = calculator.add(1.11, 2.22);
    calcWorker.release();
    await expect(sumPromise).rejects.toThrowError('signal is aborted without reason');
});

test('refCountedWorker() blocks on calls until acquired', async () => {
    const calcWorker = makeCalcWorker();
    expect(calcWorker.getState()).toBe('disconnected');

    const calculator = calcWorker.getProxy();
    expect(calcWorker.getState()).toBe('disconnected');

    let computed = false;
    calculator.add(1.11, 2.22).then(() => {
        computed = true;
    });

    expect(calcWorker.getState()).toBe('blocked');
    await delay(50);
    expect(calcWorker.getState()).toBe('blocked');
    expect(computed).toBe(false);

    calcWorker.acquire();
    expect(calcWorker.getState()).toBe('connecting');

    await expect.poll(
        () => calcWorker.getState(),
        { interval: 10, timeout: 500 }
    ).toBe('connected');

    expect(computed).toBe(true);
    expect(calcWorker.getState()).toBe('connected');

    calcWorker.release();
    expect(calcWorker.getState()).toBe('disconnected');
});

function delay(timeout: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, timeout));
}
