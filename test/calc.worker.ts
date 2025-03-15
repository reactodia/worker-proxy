import { connectWorker } from '../src/protocol.js';

class Calculator {
    private precision: number;
    
    constructor(options: { precision: number }) {
        this.precision = options.precision;
    }

    push(x: string): string {
        return 'x';
    }

    async add(a: number, b: number): Promise<number> {
        const factor = Math.pow(10, this.precision);
        return Math.round((a + b) * factor) / factor;
    }

    async slowAdd(a: number, b: number): Promise<number> {
        await delay(1000);
        return this.add(a, b);
    }
}

function delay(timeout: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, timeout));
}

connectWorker(Calculator);

export type { Calculator };
