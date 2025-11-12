// src/types/e2b.d.ts
/* Lightweight local type declarations for @e2b/code-interpreter
   These are intentionally permissive and only describe the surface
   the project uses (commands, fs, files listing, host). */

   declare module "@e2b/code-interpreter" {
    export type EntryInfo = {
      name: string;
      path: string;
      // some SDK variants use isDir, some use type flags - accept both
      isDir?: boolean;
      isDirectory?: boolean;
    };
  
    export type CommandOutput = {
      stdout?: string | null;
      stderr?: string | null;
    };
  
    // the command/exec return shape may vary between SDK versions.
    // Provide a flexible shape that contains either "exit" promise or "wait".
    export type CommandResult = {
      // older SDKs might expose "wait()" returning a Promise
      wait?: Promise<void>;
      // some expose exit promise
      exit?: Promise<void>;
      // some expose output or stdout/stderr fields
      output?: CommandOutput;
      stdout?: string | null;
      stderr?: string | null;
    };
  
    export interface SandboxFS {
      write(path: string, content: string | Uint8Array): Promise<void>;
      read(path: string): Promise<string>;
      list(path: string): Promise<EntryInfo[]>;
    }
  
    export interface SandboxCommands {
      // allow any signature for run; return CommandResult-like object
      run(cmd: string, opts?: {
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      }): Promise<CommandResult>;
    }
  
    export interface SandboxProcess {
      // compatibility alias used in older code: process.start(...)
      start?(opts: { cmd: string; onStdout?: (s: string) => void; onStderr?: (s: string) => void }): Promise<{
        wait?: Promise<void>;
        stdout?: string | null;
        stderr?: string | null;
      }>;
    }
  
    export interface Sandbox {
      // returns the public host string (no protocol) or full URL depending on SDK
      getHost(): string;
      // commands.run(...) modern API
      commands: SandboxCommands;
      // backward-compatible alias (some versions use process.start)
      process?: SandboxProcess;
      // file operations
      fs: SandboxFS;
      // additional optional fields — keep permissive
      files?: SandboxFS;
      // may have other optional helper properties; allow indexing
      [k: string]: any;
      close?(): Promise<void>;
    }
  
    export type SandboxCreateOptions = {
      timeoutMs?: number;
      metadata?: Record<string, any>;
      // other options accepted by the SDK
      [k: string]: any;
    };
  
    // Provide both overload forms (opts only or templateId + opts)
    export const Sandbox: {
      create(templateId: string, opts?: SandboxCreateOptions): Promise<Sandbox>;
      create(opts?: SandboxCreateOptions): Promise<Sandbox>;
    };
  
    export default Sandbox;
  }
  