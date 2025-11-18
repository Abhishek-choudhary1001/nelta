// src/types/e2b.d.ts - Updated for latest E2B SDK versions

declare module "@e2b/code-interpreter" {
  export type EntryInfo = {
    name: string;
    path: string;
    isDir?: boolean;
    isDirectory?: boolean;
  };

  export type CommandOutput = {
    stdout?: string | null;
    stderr?: string | null;
    output?: string | null;
  };

  export type CommandResult = {
    wait?: Promise<void>;
    exit?: Promise<void>;
    output?: CommandOutput;
    stdout?: string | null;
    stderr?: string | null;
  };

  // Modern filesystem API
  export interface SandboxFilesystem {
    write(path: string, content: string | Uint8Array): Promise<void>;
    read(path: string): Promise<string>;
    list(path: string): Promise<EntryInfo[]>;
  }

  // Legacy fs API (older versions)
  export interface SandboxFS {
    write(path: string, content: string | Uint8Array): Promise<void>;
    read(path: string): Promise<string>;
    list(path: string): Promise<EntryInfo[]>;
  }

  export interface SandboxCommands {
    run(cmd: string, opts?: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }): Promise<CommandResult>;
  }

  export interface SandboxProcess {
    start?(opts: { 
      cmd: string; 
      onStdout?: (s: string) => void; 
      onStderr?: (s: string) => void 
    }): Promise<{
      wait?: Promise<void>;
      stdout?: string | null;
      stderr?: string | null;
    }>;
  }

  export interface Sandbox {
    // Hostname methods (different across versions)
    getHostname?(): string;
    getHost?(): string;
    host?: string;
    hostname?: string;
    id?: string;
    sandboxId?: string;
    sandboxID?: string;
    
    // File system (multiple possible APIs)
    filesystem?: SandboxFilesystem;  // Modern API
    fs?: SandboxFS;                  // Legacy API
    files?: SandboxFS;               // Alternative legacy API
    
    // Commands
    commands: SandboxCommands;
    
    // Process management
    process?: SandboxProcess;
    
    // Lifecycle
    close?(): Promise<void>;
    setTimeout?(ms: number): Promise<void>;
    
    // Allow indexing for version flexibility
    [k: string]: any;
  }

  export type SandboxCreateOptions = {
    timeoutMs?: number;
    metadata?: Record<string, any>;
    [k: string]: any;
  };

  export const Sandbox: {
    create(templateId: string, opts?: SandboxCreateOptions): Promise<Sandbox>;
    create(opts?: SandboxCreateOptions): Promise<Sandbox>;
    connect(sandboxId: string): Promise<Sandbox>;
  };

  export default Sandbox;
}