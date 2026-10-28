declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, text: string): void
  export function mkdirSync(path: string, options: { recursive: true }): void
  export function statSync(path: string): { mtimeMs: number; isFile(): boolean; isDirectory(): boolean }
  export function rmSync(path: string, options: { force: true }): void
}

declare module 'node:child_process' {
  type Stdio = 'ignore' | 'pipe'
  type Child = { unref(): void; stdin: { end(text: string): void } | null }
  export function spawn(command: string, args: readonly string[], options: { detached?: boolean; stdio?: Stdio | readonly Stdio[]; env?: Record<string, string | undefined> }): Child
  export function spawnSync(command: string, args: readonly string[], options: { input?: string; encoding: 'utf8'; timeout?: number; stdio?: readonly Stdio[]; env?: Record<string, string | undefined> }): { stdout: string | null; status: number | null }
}

declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  execPath: string
  stdin: AsyncIterable<string | Uint8Array> & { setEncoding(encoding: 'utf8'): void }
  stdout: { write(text: string): boolean }
}

declare function setTimeout(callback: (value: unknown) => void, ms: number): unknown
