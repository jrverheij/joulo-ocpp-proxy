declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearInterval(intervalId: any): void;
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearTimeout(timeoutId: any): void;

declare module "fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, options?: any): string;
  export const promises: {
    mkdir(path: string, options?: any): Promise<void>;
    writeFile(path: string, data: any, options?: any): Promise<void>;
  };
}

declare module "path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "events" {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }
}

declare module "node:test" {
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
}

declare module "node:assert" {
  export function strictEqual(actual: any, expected: any, message?: string | Error): void;
  export function match(value: string, regExp: RegExp, message?: string | Error): void;
}
