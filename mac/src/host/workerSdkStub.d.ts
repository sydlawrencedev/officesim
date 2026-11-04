/*
 * Type-checking only. The office UI imports types from ../src/worker.ts, which imports the
 * Paperclip worker SDK; the Mac app never runs the worker, so these declare just enough of the
 * SDK for that file to check. Anything wider is typed loosely on purpose.
 */

type Params = Record<string, unknown>;

export interface PluginContext {
  logger: { info(message: string, meta?: Params): void; warn(message: string, meta?: Params): void; error(message: string, meta?: Params): void };
  data: { register(key: string, handler: (params: Params) => Promise<unknown>): void };
  actions: { register(key: string, handler: (params: Params) => Promise<unknown>): void };
  db: { namespace: string; query(sql: string, params?: unknown[]): Promise<unknown[]>; execute(sql: string, params?: unknown[]): Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agents: { list(input: Params): Promise<any[]>; invoke(...args: any[]): Promise<any> };
  http: { fetch(url: string, init?: RequestInit): Promise<Response> };
  config: { get(companyId?: string): Promise<Params> };
  secrets: { resolve(ref: string, scope?: Params): Promise<string> };
  state: { get(scope: Params): Promise<unknown>; set(scope: Params, value: unknown): Promise<void> };
}

export declare function definePlugin(definition: {
  setup(ctx: PluginContext): Promise<void>;
  onHealth?(): Promise<unknown>;
  [key: string]: unknown;
}): unknown;
export declare function runWorker(plugin: unknown, url: string): void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PaperclipPluginManifestV1 = any;
