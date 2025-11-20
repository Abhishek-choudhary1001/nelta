/* src/inngest/langchain-function.ts
   Updated for E2B v2.x code-interpreter
*/

import { inngest } from "./client";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import prisma from "@/lib/db";
import { PROMPT } from "@/prompts";
import { Sandbox } from "@e2b/code-interpreter";

const SANDBOX_TEMPLATE_ID = "r1xgkdrh3m2a4p8uieu7";

/** Get sandbox hostname/domain */
function getSandboxHostname(sandbox: Sandbox): string {
  const s = sandbox as any;
  
  // Directly construct from sandboxId and sandboxDomain (most reliable for E2B v2.x)
  if (s.sandboxId && s.sandboxDomain) {
    const domain = `${s.sandboxId}.${s.sandboxDomain}`;
    console.log("[getSandboxHostname] Constructed domain:", domain, "from sandboxId:", s.sandboxId, "and sandboxDomain:", s.sandboxDomain);
    return domain;
  }
  
  // Fallback: just sandboxId with default E2B domain
  if (s.sandboxId) {
    const domain = `${s.sandboxId}.e2b.dev`;
    console.log("[getSandboxHostname] Fallback domain:", domain);
    return domain;
  }
  
  // Other legacy methods
  if (typeof s.getHostname === "function") {
    const host = s.getHostname();
    if (host) return host;
  }
  if (s.host) return s.host;
  if (s.hostname) return s.hostname;
  
  console.error("[getSandboxHostname] Could not find hostname!");
  throw new Error("Unable to resolve sandbox hostname");
}

/** Build URL optionally including a port (E2B format: https://PORT-sandboxId.domain) */
function buildSandboxUrl(hostname: string, port?: number) {
  const stripped = String(hostname).replace(/^https?:\/\//, "");
  if (port) {
    // E2B format: https://3000-sandboxId.e2b.app
    return `https://3000-${stripped}`;
  }
  return `https://3000-${stripped}`;
}

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent", retries: 0 },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    let sandbox: Sandbox;

    try {
      /* ========== CREATE SANDBOX ========== */
      console.log("[Sandbox] Creating sandbox with template:", SANDBOX_TEMPLATE_ID);
      sandbox = await Sandbox.create(SANDBOX_TEMPLATE_ID, {
        timeoutMs: 900_000,
        metadata: { projectId: event.data.projectId },
      });
      
      const s = sandbox as any;
      console.log("[Sandbox] Created successfully. Details:", {
        sandboxId: s.sandboxId,
        sandboxDomain: s.sandboxDomain,
      });

      /* ========== INIT MODEL ========== */
      const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL ?? "anthropic/claude-3.5-sonnet",
        openAIApiKey: process.env.OPENROUTER_API_KEY,
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
        temperature: 0.2,
      });

      /* ========== TOOLS ========== */

      // Terminal tool -> uses sandbox.commands.run
      const terminalTool = new DynamicStructuredTool({
        name: "terminal",
        description: "Run shell commands in the sandbox. Use this to install packages with npm install.",
        schema: z.object({ command: z.string() }),
        func: async ({ command }: { command: string }) => {
          try {
            console.log("[terminal] Running command:", command);
            const result = await sandbox.commands.run(command);
            const output = result.stdout || result.stderr || "Command executed successfully";
            console.log("[terminal] Output:", output.substring(0, 200));
            return output;
          } catch (e: any) {
            console.error("[Tool: terminal] error:", e);
            return `Error executing command: ${e?.message ?? String(e)}`;
          }
        },
      });

      // File write tool -> uses sandbox.files.write
      const fileWriteTool = new DynamicStructuredTool({
        name: "createOrUpdateFiles",
        description: "Write files to the sandbox. Provide files array with path and content. Use relative paths like 'app/page.tsx'.",
        schema: z.object({
          files: z.array(z.object({ 
            path: z.string().describe("Relative file path like 'app/page.tsx'"), 
            content: z.string().describe("File content")
          })),
        }),
        func: async ({ files }: { files: { path: string; content: string }[] }) => {
          const results: string[] = [];

          try {
            for (const f of files) {
              try {
                // normalize path - remove leading slashes and /home/user prefix
                const cleanPath = String(f.path || "")
                  .replace(/^\/+/, "")
                  .replace(/^home\/user\//, "");
                
                if (!cleanPath) {
                  results.push(`❌ Invalid path: empty or undefined`);
                  continue;
                }

                const fullPath = `/home/user/${cleanPath}`;

                // ensure directory exists
                const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
                if (dir && dir !== "/home/user") {
                  try {
                    await sandbox.commands.run(`mkdir -p "${dir}"`);
                  } catch (mkdirErr) {
                    console.warn("[createOrUpdateFiles] mkdir warning:", mkdirErr);
                  }
                }

                // write file
                await sandbox.files.write(fullPath, String(f.content ?? ""));
                results.push(`✅ ${cleanPath}`);
                console.log(`[createOrUpdateFiles] wrote ${cleanPath}`);
              } catch (innerErr: any) {
                console.error("[createOrUpdateFiles] write failed for", f.path, ":", innerErr);
                results.push(`❌ ${f.path}: ${innerErr?.message ?? String(innerErr)}`);
              }
            }

            return `File operations complete:\n${results.join("\n")}`;
          } catch (err: any) {
            console.error("[createOrUpdateFiles] error:", err);
            return `Error writing files: ${err?.message ?? String(err)}`;
          }
        },
      });

      // File read tool -> uses sandbox.files.read
      const readFilesTool = new DynamicStructuredTool({
        name: "readFiles",
        description: "Read files from the sandbox. Provide an array of file paths to read.",
        schema: z.object({ paths: z.array(z.string()) }),
        func: async ({ paths }: { paths: string[] }) => {
          const out: Record<string, string> = {};

          try {
            for (const p of paths) {
              try {
                // Support both absolute and relative paths
                const fullPath = p.startsWith("/") ? p : `/home/user/${p}`;
                const content = await sandbox.files.read(fullPath);
                const displayPath = fullPath.replace(/^\/home\/user\//, "");
                out[displayPath] = String(content ?? "");
              } catch (inner: any) {
                console.warn("[readFiles] failed to read", p, ":", inner);
                out[p] = `Error reading file: ${inner?.message ?? String(inner)}`;
              }
            }

            return JSON.stringify(out, null, 2);
          } catch (err: any) {
            console.error("[readFiles] error:", err);
            return `Error reading files: ${err?.message ?? String(err)}`;
          }
        },
      });

      const modelWithTools = model.bindTools([terminalTool, fileWriteTool, readFilesTool]);

      /* ========== CONVERSATION HISTORY ========== */
      const previousMessages = await step.run("load-messages", async () => {
        const msgs = await prisma.message.findMany({
          where: { projectId: event.data.projectId },
          orderBy: { createdAt: "asc" },
          take: 10,
        });
        return msgs.map((m) => ({
          role: m.role === "ASSISTANT" ? ("assistant" as const) : ("user" as const),
          content: m.content ?? "",
        }));
      });

      const messages: any[] = [
        { role: "system", content: PROMPT }, 
        ...previousMessages, 
        { role: "user", content: event.data.value }
      ];

      /* ========== AGENT LOOP ========== */
      console.log("[Agent] Starting loop");
      const assistantTexts: string[] = [];
      const maxIterations = 12;
      let iterations = 0;

      while (iterations < maxIterations) {
        const resp = await modelWithTools.invoke(messages);

        // collect assistant content
        if (resp?.content) {
          const txt = typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
          if (txt.trim()) {
            assistantTexts.push(txt);
            messages.push({ role: "assistant", content: txt });
            console.log("[Agent] assistant:", txt.substring(0, 200));
          }
        }

        const toolCalls = resp?.tool_calls ?? [];
        if (!toolCalls.length) {
          console.log("[Agent] No tool calls; breaking");
          break;
        }

        for (const tc of toolCalls) {
          let toolResult = "";
          try {
            console.log("[Agent] Tool call:", tc.name, "with args:", JSON.stringify(tc.args).substring(0, 200));
            switch (tc.name) {
              case "terminal":
                toolResult = await terminalTool.func(tc.args as { command: string });
                break;
              case "createOrUpdateFiles":
                toolResult = await fileWriteTool.func(tc.args as { files: { path: string; content: string }[] });
                break;
              case "readFiles":
                toolResult = await readFilesTool.func(tc.args as { paths: string[] });
                break;
              default:
                toolResult = `Unknown tool: ${tc.name}`;
            }
          } catch (toolErr: any) {
            console.error("[Agent] tool error:", toolErr);
            toolResult = `Tool error: ${toolErr?.message ?? String(toolErr)}`;
          }

          messages.push({ role: "tool", content: toolResult, tool_call_id: tc.id });
        }

        iterations++;
      }

      // ensure there is some assistant output
      if (!assistantTexts.length) {
        const summaryResp = await model.invoke([
          ...messages, 
          { role: "user", content: "Please summarize what you did in one short paragraph." }
        ]);
        const summaryText = typeof summaryResp.content === "string" 
          ? summaryResp.content 
          : JSON.stringify(summaryResp.content);
        assistantTexts.push(summaryText);
      }

      const combinedAssistant = assistantTexts.join("\n\n");

      /* ========== DISCOVER GENERATED FILES ========== */
      const generatedFiles = await step.run("discover-files", async () => {
        const files: Record<string, string> = {};

        // Helper for reading a path
        const tryRead = async (fullPath: string): Promise<string | null> => {
          try {
            return await sandbox.files.read(fullPath);
          } catch {
            return null;
          }
        };

        // Try listing files in key directories
        try {
          const candidates = ["/home/user", "/home/user/app", "/home/user/public"];
          for (const dir of candidates) {
            try {
              const fileList: any[] = await sandbox.files.list(dir);
              for (const item of fileList || []) {
                if (!item) continue;
                const itemName: string = item.name ?? item.path ?? "";
                if (!itemName) continue;
                
                // Skip directories
                const isDir = item.isDir ?? item.isDirectory ?? false;
                if (isDir) continue;
                
                // Only capture relevant file types
                if (/\.(tsx?|jsx?|html|json|css|js)$/.test(itemName)) {
                  const rel = dir === "/home/user" 
                    ? itemName 
                    : `${dir.replace("/home/user/", "")}/${itemName}`.replace(/^\/+/, "");
                  const full = `/home/user/${rel}`;
                  const content = await tryRead(full);
                  if (content) files[rel] = String(content);
                }
              }
            } catch (err) {
              console.warn("[discover-files] Failed to list", dir, ":", err);
            }
          }
        } catch {
          // If list fails, attempt to read well-known paths
          const known = ["app/page.tsx", "app/layout.tsx", "package.json", "index.html"];
          for (const k of known) {
            try {
              const full = `/home/user/${k}`;
              const c = await tryRead(full);
              if (c) files[k] = String(c);
            } catch {
              // ignore
            }
          }
        }

        console.log("[discover-files] Found", Object.keys(files).length, "files");
        return files;
      });

      /* ========== Try to start Next.js dev server ========== */
      console.log("[Server] All discovered files:", Object.keys(generatedFiles));
      console.log("[Server] Checking for Next.js app files...");
      console.log("[Server] - Looking for 'app/page.tsx':", !!generatedFiles["app/page.tsx"]);
      console.log("[Server] - Looking for 'package.json':", !!generatedFiles["package.json"]);
      
      const hasNextApp = Boolean(generatedFiles["app/page.tsx"] && generatedFiles["package.json"]);
      console.log("[Server] Has Next app?", hasNextApp);
      
      const hostname = getSandboxHostname(sandbox);
      console.log("[Server] Sandbox hostname:", hostname);
      let sandboxUrl = buildSandboxUrl(hostname);
      console.log("[Server] Base sandbox URL:", sandboxUrl);

      if (hasNextApp) {
        console.log("[Server] Next.js app detected, starting server...");
        await step.run("start-next-server", async () => {
          try {
            console.log("[Server] Starting Next.js dev server on port 3000");
            // Start server in background using shell command
            await sandbox.commands.run("cd /home/user && nohup npm run dev -- --port 3000 > /tmp/next.log 2>&1 &");

            // poll for readiness
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
                  console.log("[Server] Next.js ready at", testUrl);
                  break;
                }
              } catch {
                // not ready yet
              }
              await new Promise((r) => setTimeout(r, 2000));
            }

            sandboxUrl = ready ? buildSandboxUrl(hostname, 3000) : buildSandboxUrl(hostname);
          } catch (startErr: any) {
            console.error("[start-next-server] failed:", startErr);
            sandboxUrl = buildSandboxUrl(hostname);
          }
        });
      } else {
        console.log("[Server] No Next.js app detected, using base sandbox URL");
        sandboxUrl = buildSandboxUrl(hostname);
      }

      /* ========== Persist result to DB ========== */
      await step.run("save-to-database", async () => {
        await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: combinedAssistant || "✅ Generated application (no assistant content).",
            role: "ASSISTANT",
            type: "RESULT",
            fragment: {
              create: {
                sandboxUrl,
                title: "Generated Application",
                files: generatedFiles,
              },
            },
          },
        });
      });

      return {
        success: true,
        url: sandboxUrl,
        response: combinedAssistant,
        files: generatedFiles,
        fileCount: Object.keys(generatedFiles).length,
      };
    } catch (err: unknown) {
      const e = err as Error;
      console.error("❌ [Agent Error]:", e);
      try {
        await prisma.message.create({
          data: {
            projectId: event.data?.projectId ?? "unknown",
            content: `Error: ${e.message}\n\n${e.stack ?? ""}`,
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      } catch (dbErr) {
        console.error("[DB] failed to log error:", dbErr);
      }
      return { error: true, message: e.message, stack: e.stack };
    } finally {
      console.log("[Sandbox] Leaving sandbox alive for preview");
    }
  }
);
