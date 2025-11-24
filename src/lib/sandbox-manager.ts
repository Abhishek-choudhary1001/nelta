// src/lib/sandbox-manager.ts
import { Sandbox } from "@e2b/code-interpreter";
import prisma from "./db";

const SANDBOX_TEMPLATE_ID = "r1xgkdrh3m2a4p8uieu7";

interface SandboxResult {
  sandbox: Sandbox;
  url: string;
  isNew: boolean;
}

/**
 * Get sandbox hostname from sandbox instance
 */
function getSandboxHostname(sandbox: Sandbox): string {
  const s = sandbox as any;
  
  if (s.sandboxId && s.sandboxDomain) {
    return `${s.sandboxId}.${s.sandboxDomain}`;
  }
  
  if (s.sandboxId) {
    return `${s.sandboxId}.e2b.dev`;
  }
  
  throw new Error("Unable to resolve sandbox hostname");
}

/**
 * Build sandbox URL with port
 */
function buildSandboxUrl(hostname: string, port: number = 3000): string {
  const stripped = String(hostname).replace(/^https?:\/\//, "");
  return `https://${port}-${stripped}`;
}

/**
 * Ensure directory exists in sandbox
 */
async function ensureDirectoryExists(sandbox: Sandbox, dirPath: string) {
  try {
    await sandbox.commands.run(`mkdir -p "${dirPath}"`);
  } catch (err: any) {
    console.warn("[ensureDirectoryExists] Warning:", err?.message);
  }
}

/**
 * Write files to sandbox
 */
async function writeFilesToSandbox(
  sandbox: Sandbox,
  files: Record<string, string>
): Promise<void> {
  // First pass: create all directories
  const dirsToCreate = new Set<string>();
  for (const filePath of Object.keys(files)) {
    const cleanPath = filePath.replace(/^\/+/, "").replace(/^home\/user\//, "");
    if (cleanPath.includes("/")) {
      const dir = cleanPath.substring(0, cleanPath.lastIndexOf("/"));
      if (dir) {
        dirsToCreate.add(`/home/user/${dir}`);
      }
    }
  }

  for (const dir of dirsToCreate) {
    await ensureDirectoryExists(sandbox, dir);
  }

  // Second pass: write all files
  for (const [filePath, content] of Object.entries(files)) {
    try {
      const cleanPath = filePath.replace(/^\/+/, "").replace(/^home\/user\//, "");
      const fullPath = `/home/user/${cleanPath}`;
      
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (dir && dir !== "/home/user") {
        await ensureDirectoryExists(sandbox, dir);
      }

      await sandbox.files.write(fullPath, String(content ?? ""));
      console.log(`[writeFilesToSandbox] Wrote ${cleanPath}`);
    } catch (err: any) {
      console.error(`[writeFilesToSandbox] Failed to write ${filePath}:`, err?.message);
    }
  }
}

/**
 * Start Next.js dev server in sandbox
 */
async function startNextServer(sandbox: Sandbox, hostname: string): Promise<string> {
  try {
    console.log("[startNextServer] Starting Next.js dev server...");
    await sandbox.commands.run("cd /home/user && nohup npm run dev -- --port 3000 > /tmp/next.log 2>&1 &");

    const testUrl = buildSandboxUrl(hostname, 3000);
    let ready = false;
    
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(testUrl, { 
          method: "HEAD", 
          signal: AbortSignal.timeout(3000) 
        });
        if (res.ok) {
          ready = true;
          console.log("[startNextServer] Next.js ready at", testUrl);
          break;
        }
      } catch {
        // Keep trying
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    return ready ? buildSandboxUrl(hostname, 3000) : buildSandboxUrl(hostname);
  } catch (err: any) {
    console.error("[startNextServer] Failed:", err?.message);
    return buildSandboxUrl(hostname);
  }
}

/**
 * Check if sandbox is alive by trying to connect
 */
async function isSandboxAlive(sandboxId: string): Promise<boolean> {
  try {
    const sandbox = await Sandbox.connect(sandboxId);
    // Try a simple command to verify it's responsive
    await sandbox.commands.run("echo 'alive'");
    await sandbox.close?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get or recreate sandbox for a fragment
 * This is the main function to call from your component
 */
export async function getOrRecreateSandbox(fragmentId: string): Promise<SandboxResult> {
  // Get fragment with files from database
  const fragment = await prisma.fragment.findUnique({
    where: { id: fragmentId },
    include: {
      message: {
        include: {
          project: true
        }
      }
    }
  });

  if (!fragment) {
    throw new Error("Fragment not found");
  }

  const files = fragment.files as Record<string, string>;
  const currentUrl = fragment.sandboxUrl;
  
  // Extract sandbox ID from current URL (e.g., "https://3000-abc123.e2b.dev")
  const sandboxIdMatch = currentUrl.match(/https:\/\/\d+-([^.]+)/);
  const currentSandboxId = sandboxIdMatch?.[1];

  // Check if current sandbox is still alive
  if (currentSandboxId && await isSandboxAlive(currentSandboxId)) {
    console.log("[getOrRecreateSandbox] Existing sandbox is alive:", currentSandboxId);
    const sandbox = await Sandbox.connect(currentSandboxId);
    return {
      sandbox,
      url: currentUrl,
      isNew: false
    };
  }

  // Create new sandbox with saved files
  console.log("[getOrRecreateSandbox] Creating new sandbox with saved files...");
  const sandbox = await Sandbox.create(SANDBOX_TEMPLATE_ID, {
    timeoutMs: 900_000,
    metadata: { 
      projectId: fragment.message.projectId,
      fragmentId: fragment.id 
    },
  });

  // Write all saved files to sandbox
  await writeFilesToSandbox(sandbox, files);

  // Check if it's a Next.js app and start server
  const hasNextApp = Boolean(files["app/page.tsx"] && files["package.json"]);
  const hostname = getSandboxHostname(sandbox);
  
  let sandboxUrl: string;
  if (hasNextApp) {
    sandboxUrl = await startNextServer(sandbox, hostname);
  } else {
    sandboxUrl = buildSandboxUrl(hostname);
  }

  // Update fragment with new sandbox URL
  await prisma.fragment.update({
    where: { id: fragment.id },
    data: { sandboxUrl }
  });

  return {
    sandbox,
    url: sandboxUrl,
    isNew: true
  };
}

/**
 * Close sandbox gracefully
 */
export async function closeSandbox(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.close?.();
  } catch (err) {
    console.warn("[closeSandbox] Error closing sandbox:", err);
  }
}