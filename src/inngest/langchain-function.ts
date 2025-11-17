/* src/inngest/langchain-function.ts */
import { inngest } from "./client";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import prisma from "@/lib/db";
import { PROMPT } from "@/prompts";
import { Sandbox } from "@e2b/code-interpreter";

const SANDBOX_TEMPLATE_ID = "2kmaga44jttvxphjuxkz";

/**
 * Try several possible ways to get a sandbox host/hostname from different E2B SDK shapes.
 * Returns just the hostname (no protocol). Throw if not resolvable.
 */
function getSandboxHostname(sandbox: Sandbox): string {
  // 1) Newer SDK: id or sandboxID -> e.g. "k0wmnzir0..."
  const asAny = sandbox as any;
  const sandboxId = asAny.id ?? asAny.sandboxID ?? asAny.sandboxId;
  if (sandboxId && typeof sandboxId === "string") {
    // many e2b setups map id -> <id>.e2b.dev or similar; prefer id without protocol
    return `${sandboxId}.e2b.dev`;
  }

  // 2) Common SDK methods
  if (typeof asAny.getHostname === "function") {
    const val = asAny.getHostname();
    if (val) return String(val);
  }
  if (typeof asAny.getHost === "function") {
    const val = asAny.getHost();
    if (val) return String(val);
  }

  // 3) Properties
  if (asAny.host) return String(asAny.host);
  if (asAny.hostname) return String(asAny.hostname);

  // 4) metadata
  if (asAny.metadata?.hostname) return String(asAny.metadata.hostname);
  if (asAny.metadata?.host) return String(asAny.metadata.host);

  // Nothing found -> give detailed diagnostic info in thrown error
  const keys = Object.keys(asAny).slice(0, 50);
  throw new Error(
    `Unable to resolve sandbox hostname. Sandbox keys: [${keys.join(
      ", "
    )}]. Check SDK version.`
  );
}

/**
 * Helper to get full URL (prefers https, app server uses port 3000 for HTML)
 */
function buildSandboxUrl(hostname: string, port?: number) {
  // if hostname already has protocol, strip it
  const stripped = String(hostname).replace(/^https?:\/\//, "");
  if (port) return `https://${stripped}:${port}`;
  // default to https host root
  return `https://${stripped}`;
}

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent", retries: 0 },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    let sandbox: Sandbox | null = null;

    try {
      /* ---------------- Create sandbox ---------------- */
      sandbox = (await step.run("create-sandbox", async () => {
        console.log("[Sandbox] Creating E2B sandbox...");
        const sbx = await Sandbox.create(SANDBOX_TEMPLATE_ID, {
          timeoutMs: 900_000,
          metadata: { projectId: event.data.projectId },
        });

        // Debug summary of created sandbox
        try {
          // Print top-level keys and important props
          const keys = Object.keys(sbx as any).slice(0, 40);
          console.log("[Sandbox] created object keys:", keys);
          const asAny = sbx as any;
          console.log("[Sandbox] example props:", {
            id: asAny.id ?? asAny.sandboxID ?? asAny.sandboxId,
            host: asAny.host ?? asAny.hostname,
            hasGetHost: typeof asAny.getHost === "function",
            hasGetHostname: typeof asAny.getHostname === "function",
            metadata: asAny.metadata ? "(present)" : "(none)",
          });
        } catch (err) {
          console.warn("[Sandbox] debug print failed:", err);
        }

        return sbx;
      })) as unknown as Sandbox;

      /* ---------------- LangChain model ---------------- */
      const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL ?? "qwen/qwen3-coder:free",
        openAIApiKey: process.env.OPENROUTER_API_KEY,
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
        temperature: 0.2,
      });

      /* ---------------- Tools ---------------- */
      const terminalTool = new DynamicStructuredTool({
        name: "terminal",
        description: "Run terminal commands inside sandbox",
        schema: z.object({ command: z.string() }),
        func: async ({ command }) => {
          console.log(`[Tool: terminal] ${command}`);
          try {
            const proc = await sandbox!.commands.run(command, {
              onStdout: (d: string) => console.log(`[stdout] ${d}`),
              onStderr: (d: string) => console.error(`[stderr] ${d}`),
            });
            // many sdk shapes: prefer stdout, fallback to proc.output/stdout-like shapes
            return (proc.stdout ?? (proc as any).output ?? (proc as any).stdout) || "OK";
          } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return `Error: ${errMsg}`;
          }
        },
      });

      const fileWriteTool = new DynamicStructuredTool({
        name: "createOrUpdateFiles",
        description: "Write or update files in sandbox. Provide array of {path, content}",
        schema: z.object({
          files: z.array(z.object({ path: z.string(), content: z.string() })),
        }),
        func: async ({ files }) => {
          console.log(`[Tool] Writing ${files.length} file(s)`);
          try {
            for (const file of files) {
              const normalizedPath = file.path.replace(/^\/home\/user\//, "");
              const fullPath = `/home/user/${normalizedPath}`;
              await sandbox!.fs.write(fullPath, file.content);
              console.log(`[Tool] Wrote: ${fullPath}`);
            }
            return `✅ Successfully wrote ${files.length} file(s)`;
          } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return `Error writing files: ${errMsg}`;
          }
        },
      });

      const readFilesTool = new DynamicStructuredTool({
        name: "readFiles",
        description: "Read files from sandbox",
        schema: z.object({ paths: z.array(z.string()) }),
        func: async ({ paths }) => {
          const results: Record<string, string> = {};
          try {
            for (const filePath of paths) {
              const normalizedPath = filePath.replace(/^\/home\/user\//, "");
              const fullPath = `/home/user/${normalizedPath}`;
              const content = await sandbox!.fs.read(fullPath);
              results[normalizedPath] = content;
            }
            return JSON.stringify(results, null, 2);
          } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return `Error reading files: ${errMsg}`;
          }
        },
      });

      const modelWithTools = model.bindTools([terminalTool, fileWriteTool, readFilesTool]);

      /* ---------------- Load previous messages ---------------- */
      const previousMessages = await step.run("load-msgs", async () => {
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

      /* ---------------- Build conversation ---------------- */
      const messages: any[] = [
        { role: "system", content: PROMPT },
        ...previousMessages,
        { role: "user", content: event.data.value },
      ];

      /* ---------------- Agent tool loop (with protections) ---------------- */
      console.log("[Agent] Starting tool loop...");
      let iterations = 0;
      const maxIterations = 10; // reduced to prevent rate-limits
      let consecutiveNoProgress = 0;
      const maxNoProgress = 3;
      let response: any;
      let lastText = "";
      const assistantTexts: string[] = [];

      while (iterations < maxIterations) {
        response = await modelWithTools.invoke(messages);

        // capture any assistant text
        if (response?.content) {
          const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
          if (text.trim()) {
            assistantTexts.push(text);
            lastText = text;
            messages.push({ role: "assistant", content: text });
          }
        }

        // if no tool calls -> done
        const toolCalls = response?.tool_calls ?? [];
        if (!toolCalls.length) {
          consecutiveNoProgress++;
          if (consecutiveNoProgress >= maxNoProgress) {
            console.log("[Agent] No progress for several iterations - breaking");
            break;
          }
          // If no tool calls but we got content, we can end
          if (lastText) {
            console.log("[Agent] No tool calls and assistant gave content -> done");
            break;
          }
        } else {
          consecutiveNoProgress = 0;
        }

        // execute tool calls
        for (const toolCall of toolCalls) {
          let toolResult = "";
          switch (toolCall.name) {
            case "terminal":
              toolResult = await terminalTool.func(toolCall.args as { command: string });
              break;
            case "createOrUpdateFiles":
              toolResult = await fileWriteTool.func(toolCall.args as { files: { path: string; content: string }[] });
              break;
            case "readFiles":
              toolResult = await readFilesTool.func(toolCall.args as { paths: string[] });
              break;
            default:
              toolResult = `Unknown tool: ${toolCall.name}`;
          }
          messages.push({ role: "tool", content: toolResult, tool_call_id: toolCall.id });
        }

        iterations++;
      }

      if (!lastText) {
        // Ask for a short summary
        console.log("[Agent] No final assistant text - requesting summary");
        const summaryResp = await model.invoke([
          ...messages,
          { role: "user", content: "Please provide a short summary of what you built." },
        ]);
        lastText = typeof summaryResp.content === "string" ? summaryResp.content : JSON.stringify(summaryResp.content);
        assistantTexts.push(lastText);
      }

      const combinedAssistant = assistantTexts.join("\n\n");

      /* ---------------- Read generated files from sandbox ---------------- */
      const generatedFiles = await step.run("read-files", async () => {
        const files: Record<string, string> = {};
        // Check a set of common file locations (absolute)
        const baseCandidates = [
          "/home/user/app/page.tsx",
          "/home/user/app/layout.tsx",
          "/home/user/tailwind.config.ts",
          "/home/user/package.json",
        ];

        for (const fullPath of baseCandidates) {
          try {
            const c = await sandbox!.fs.read(fullPath);
            const rel = fullPath.replace(/^\/home\/user\//, "");
            files[rel] = c;
            console.log(`[Files] Read base: ${rel}`);
          } catch {
            // ignore
          }
        }

        // Discover files in /home/user/app
        try {
          const appList = await sandbox!.fs.list("/home/user/app");
          for (const file of appList) {
            if (!file.isDir && /\.(tsx?|jsx?|json|css|html)$/.test(file.name)) {
              const p = `/home/user/app/${file.name}`;
              try {
                const c = await sandbox!.fs.read(p);
                files[`app/${file.name}`] = c;
                console.log(`[Files] Discovered app/${file.name}`);
              } catch {}
            }
          }
        } catch {
          console.log("[Files] Could not list /home/user/app");
        }

        // Discover root-level files
        try {
          const rootList = await sandbox!.fs.list("/home/user");
          for (const file of rootList) {
            if (!file.isDir && /\.(html?|tsx?|jsx?|json|css)$/.test(file.name)) {
              const p = `/home/user/${file.name}`;
              try {
                const c = await sandbox!.fs.read(p);
                files[file.name] = c;
                console.log(`[Files] Discovered ${file.name}`);
              } catch {}
            }
          }
        } catch {
          console.log("[Files] Could not list /home/user");
        }

        console.log(`[Files] Total files read: ${Object.keys(files).length}`);
        return files;
      });

      /* ---------------- Start app / determine preview URL ---------------- */
      const hasHtml = Object.keys(generatedFiles).some((f) => f.endsWith(".html"));
      const hasNext = Boolean(generatedFiles["app/page.tsx"] && generatedFiles["package.json"]);

      let sandboxUrl = "";
      const hostname = getSandboxHostname(sandbox!); // may throw

      if (hasNext) {
        // Try start Next dev server on port 3000 and wait
        await step.run("start-nextjs", async () => {
          try {
            // kill process on port if any (best-effort)
            try {
              await sandbox!.commands.run("lsof -ti:3000 | xargs kill -9 || true");
            } catch {}
            sandbox!.process?.start?.({
              cmd: "cd /home/user && npm run dev -- --port 3000",
              onStdout: (d: string) => console.log(`[Server] ${d}`),
              onStderr: (d: string) => console.error(`[Server] ${d}`),
            });
            // Wait for server up
            let tries = 0;
            const maxTries = 30;
            while (tries < maxTries) {
              try {
                const res = await fetch(buildSandboxUrl(hostname, 3000), { method: "HEAD", signal: AbortSignal.timeout(3000) });
                if (res.ok) break;
              } catch {
                // retry
              }
              await new Promise((r) => setTimeout(r, 2000));
              tries++;
            }
          } catch (err) {
            console.warn("[Server] starting Next.js failed:", err);
          }
        });
        sandboxUrl = buildSandboxUrl(hostname, 3000);
      } else if (hasHtml) {
        await step.run("start-http-server", async () => {
          try {
            await sandbox!.commands.run("lsof -ti:3000 | xargs kill -9 || true");
          } catch {}
          sandbox!.process?.start?.({
            cmd: "cd /home/user && python3 -m http.server 3000",
            onStdout: (d: string) => console.log(`[Server] ${d}`),
            onStderr: (d: string) => console.error(`[Server] ${d}`),
          });
          await new Promise((r) => setTimeout(r, 3000));
        });

        // choose index.html if present
        const htmlFiles = Object.keys(generatedFiles).filter((f) => f.endsWith(".html"));
        const entry = htmlFiles.find((f) => /index\.html$/i.test(f)) ?? htmlFiles[0];
        sandboxUrl = entry ? `${buildSandboxUrl(hostname, 3000)}/${entry}` : buildSandboxUrl(hostname, 3000);
      } else {
        sandboxUrl = buildSandboxUrl(hostname);
      }

      /* ---------------- Save to DB ---------------- */
      await step.run("save-to-db", async () => {
        const messageContent = combinedAssistant || lastText || "✅ App built successfully!";
        await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: String(messageContent),
            role: "ASSISTANT",
            type: "RESULT",
            fragment: {
              create: {
                sandboxUrl,
                title: "Generated App",
                files: generatedFiles,
              },
            },
          },
        });
        console.log(`[DB] Saved message, sandboxUrl=${sandboxUrl}, files=${Object.keys(generatedFiles).length}`);
      });

      return {
        success: true,
        url: sandboxUrl,
        response: combinedAssistant || lastText,
        files: generatedFiles,
        fileCount: Object.keys(generatedFiles).length,
      };
    } catch (err: unknown) {
      const error = err as Error;
      console.error("❌ [Agent Error]:", error);
      try {
        await prisma.message.create({
          data: {
            projectId: event.data?.projectId ?? "unknown",
            content: `Error: ${error.message}\n\nStack: ${error.stack}`,
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      } catch (e) {
        console.error("[DB] Failed to record error:", e);
      }
      return { error: true, message: error.message };
    } finally {
      console.log("[Sandbox] Keeping sandbox alive for preview");
    }
  }
);
