/* src/inngest/langchain-function.ts
   Rewritten to use modern E2B sandbox APIs:
   - sandbox.commands.run
   - sandbox.files.read / write / list
   - sandbox.process.start
*/

import { inngest } from "./client";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import prisma from "@/lib/db";
import { PROMPT } from "@/prompts";
import { Sandbox } from "@e2b/code-interpreter";

const SANDBOX_TEMPLATE_ID = "r1xgkdrh3m2a4p8uieu7";

/** Safely read hostname from sandbox instance */
function getSandboxHostname(sandbox: Sandbox): string {
  const s = sandbox as any;
  if (typeof s.getHostname === "function") return s.getHostname();
  if (typeof s.getHost === "function") return s.getHost();
  if (s.host) return s.host;
  if (s.hostname) return s.hostname;
  const id = s.id || s.sandboxId || s.sandboxID;
  if (id) return `${id}.e2b.dev`;
  throw new Error("Unable to resolve sandbox hostname");
}

/** Build URL optionally including a port */
function buildSandboxUrl(hostname: string, port?: number) {
  const stripped = String(hostname).replace(/^https?:\/\//, "");
  return port ? `https://${stripped}:${port}` : `https://${stripped}`;
}

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent", retries: 0 },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    let sandbox: Sandbox | null = null;

    try {
      /* ========== CREATE SANDBOX ========== */
      sandbox = (await step.run("create-sandbox", async () => {
        const sbx = await Sandbox.create(SANDBOX_TEMPLATE_ID, {
          timeoutMs: 900_000,
          metadata: { projectId: event.data.projectId },
        });

        // Quick capability check: require the modern APIs
        const s = sbx as any;
        console.log("[Sandbox] capabilities:", {
          commands: !!s.commands?.run,
          files: !!s.files,
          process: !!s.process?.start,
        });

        // If modern APIs are not present, throw an explicit error
        if (!s.commands?.run || !s.files) {
          throw new Error(
            "Sandbox does not expose required modern APIs. Required: sandbox.commands.run and sandbox.files.*"
          );
        }

        return sbx;
      })) as unknown as Sandbox;

      /* ========== INIT MODEL ========== */
      const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL ?? "anthropic/claude-3.5-sonnet",
        openAIApiKey: process.env.OPENROUTER_API_KEY,
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
        temperature: 0.2,
      });

      /* ========== TOOLS (modern-only) ========== */

      // Terminal tool -> uses sandbox.commands.run
      const terminalTool = new DynamicStructuredTool({
        name: "terminal",
        description: "Run shell commands in the sandbox using sandbox.commands.run",
        schema: z.object({ command: z.string() }),
        func: async ({ command }: { command: string }) => {
          const s = sandbox as any;
          try {
            if (!s?.commands?.run) {
              throw new Error("sandbox.commands.run is not available");
            }
            const proc = await s.commands.run(command, {
              onStdout: (d: string) => console.log("[sandbox stdout]", d),
              onStderr: (d: string) => console.error("[sandbox stderr]", d),
            });
            return (proc.stdout ?? proc.output ?? "") as string;
          } catch (e: any) {
            console.error("[Tool: terminal] error:", e);
            return `Error executing command: ${e?.message ?? String(e)}`;
          }
        },
      });

      // File write tool -> uses sandbox.files.write
      const fileWriteTool = new DynamicStructuredTool({
        name: "createOrUpdateFiles",
        description:
          "Write files using sandbox.files.write. Provide files: [{ path: 'app/page.tsx', content: '...' }]",
        schema: z.object({
          files: z.array(z.object({ path: z.string(), content: z.string() })),
        }),
        func: async ({ files }: { files: { path: string; content: string }[] }) => {
          const s = sandbox as any;
          const results: string[] = [];

          try {
            if (!s?.files?.write) {
              throw new Error("sandbox.files.write is not available");
            }

            for (const f of files) {
              try {
                // normalize to /home/user/<rel>
                const rel = String(f.path).replace(/^\/+/, "").replace(/^home\/user\//, "");
                const full = `/home/user/${rel}`;

                // ensure directory exists via shell (mkdir -p)
                const dir = full.substring(0, full.lastIndexOf("/"));
                if (dir && s?.commands?.run) {
                  try {
                    await s.commands.run(`mkdir -p "${dir}"`);
                  } catch (mkdirErr) {
                    console.warn("[createOrUpdateFiles] mkdir warning:", mkdirErr);
                  }
                }

                await s.files.write(full, String(f.content ?? ""));
                results.push(`✅ ${rel}`);
                console.log(`[createOrUpdateFiles] wrote ${rel}`);
              } catch (innerErr: any) {
                console.error("[createOrUpdateFiles] write failed:", innerErr);
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
        description: "Read files using sandbox.files.read. Use full or relative paths.",
        schema: z.object({ paths: z.array(z.string()) }),
        func: async ({ paths }: { paths: string[] }) => {
          const s = sandbox as any;
          const out: Record<string, string> = {};

          try {
            if (!s?.files?.read) {
              throw new Error("sandbox.files.read is not available");
            }

            for (const p of paths) {
              try {
                const full = p.startsWith("/") ? p : `/home/user/${p}`;
                const content = await s.files.read(full);
                out[full.replace(/^\/home\/user\//, "")] = String(content ?? "");
              } catch (inner: any) {
                console.warn("[readFiles] failed:", inner);
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

      const messages: any[] = [{ role: "system", content: PROMPT }, ...previousMessages, { role: "user", content: event.data.value }];

      /* ========== AGENT LOOP ========== */
      console.log("[Agent] starting loop");
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
            console.log("[Agent] assistant:", txt.substring(0, Math.min(txt.length, 200)));
          }
        }

        const toolCalls = resp?.tool_calls ?? [];
        if (!toolCalls.length) {
          console.log("[Agent] no tool calls; breaking");
          break;
        }

        for (const tc of toolCalls) {
          let toolResult = "";
          try {
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
        const summaryResp = await model.invoke([...messages, { role: "user", content: "Please summarise what you did in one short paragraph." }]);
        const summaryText = typeof summaryResp.content === "string" ? summaryResp.content : JSON.stringify(summaryResp.content);
        assistantTexts.push(summaryText);
      }

      const combinedAssistant = assistantTexts.join("\n\n");

      /* ========== DISCOVER GENERATED FILES (modern-only) ========== */
      const generatedFiles = await step.run("discover-files", async () => {
        const s = sandbox as any;
        const files: Record<string, string> = {};

        // Helper for reading a path
        const tryRead = async (fullPath: string) => {
          try {
            return await s.files.read(fullPath);
          } catch {
            return null;
          }
        };

        // Try listing top-level directories using modern files.list (if available)
        if (s.files?.list) {
          // candidate directories to inspect
          const candidates = ["/home/user/app", "/home/user/public", "/home/user"];
          for (const dir of candidates) {
            try {
              const list = await s.files.list(dir);
              for (const item of list || []) {
                if (!item) continue;
                // item may be { name, isDir }
                const name = item.name ?? item.path ?? "";
                if (!name) continue;
                // capture common extensions
                if (/\.(tsx?|jsx?|html|json|css|js)$/.test(name)) {
                  const rel = `${dir.replace("/home/user/", "")}/${name}`.replace(/^\/+/, "");
                  const full = `/home/user/${rel}`;
                  const content = await tryRead(full);
                  if (content) files[rel] = String(content);
                }
              }
            } catch {
              // ignore listing errors per-dir
            }
          }
        } else {
          // If list is not available, attempt to read a few well-known paths
          const known = ["app/page.tsx", "app/layout.tsx", "package.json", "index.html", "calculator.html"];
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

        console.log("[discover-files] found", Object.keys(files).length, "files");
        return files;
      });

      /* ========== Try to start Next.js dev server (if app found) with modern process.start ========== */
      const hasNextApp = Boolean(generatedFiles["app/page.tsx"] && generatedFiles["package.json"]);
      const hostname = getSandboxHostname(sandbox!);
      let sandboxUrl = buildSandboxUrl(hostname);

      if (hasNextApp) {
        // only attempt server start if process.start is available
        const s = sandbox as any;
        if (s?.process?.start) {
          await step.run("start-next-server", async () => {
            try {
              // Use process.start to run `npm run dev` inside /home/user
              s.process.start({
                cmd: "cd /home/user && npm run dev -- --port 3000",
                onStdout: (d: string) => console.log("[next stdout]", d),
                onStderr: (d: string) => console.error("[next stderr]", d),
              });

              // poll HEAD to detect readiness
              const testUrl = buildSandboxUrl(hostname, 3000);
              let ready = false;
              for (let i = 0; i < 40; i++) {
                try {
                  const res = await fetch(testUrl, { method: "HEAD", signal: AbortSignal.timeout(3000) });
                  if (res.ok) {
                    ready = true;
                    console.log("[Server] Next.js ready");
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
              // fallback to base hostname
              sandboxUrl = buildSandboxUrl(hostname);
            }
          });
        } else {
          console.warn("[Server] sandbox.process.start not available; cannot start Next.js automatically");
          sandboxUrl = buildSandboxUrl(hostname);
        }
      } else {
        // if no next app, just expose base sandbox preview url
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
      console.log("[Sandbox] leaving sandbox alive for preview (if platform supports it)");
    }
  }
);
