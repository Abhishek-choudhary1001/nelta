import { inngest } from "./client";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import prisma from "@/lib/db";
import { PROMPT } from "@/prompts";
import { Sandbox } from "@e2b/code-interpreter";

// ✅ Correct template ID from your e2b.toml
const SANDBOX_TEMPLATE_ID = "r1xgkdrh3m2a4p8uieu7";

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent", retries: 0 },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    let sandbox: Sandbox | null = null;

    try {
      // 1️⃣ Create E2B Sandbox
      sandbox = (await step.run("create-sandbox", async () => {
        console.log("[Sandbox] Creating E2B sandbox...");
        const sbx = await Sandbox.create(SANDBOX_TEMPLATE_ID, {
          timeoutMs: 600_000,
          metadata: { projectId: event.data.projectId },
        });
        console.log(`[Sandbox] Created successfully: ${sbx.getHost()}`);
        return sbx;
      })) as unknown as Sandbox;
      

      // 2️⃣ Initialize LangChain Model
      const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL ?? "qwen/qwen3-coder:free",
        openAIApiKey: process.env.OPENROUTER_API_KEY,
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
        temperature: 0.2,
      });

      // 3️⃣ Define Tools
      const terminalTool = new DynamicStructuredTool({
        name: "terminal",
        description: "Run terminal commands inside sandbox (e.g., npm install)",
        schema: z.object({ command: z.string() }),
        func: async ({ command }) => {
          console.log(`[Tool: terminal] ${command}`);
          try {
            const proc = await sandbox!.commands.run(command, {
              onStdout: (d: string) => console.log(`[stdout] ${d}`),
              onStderr: (d: string) => console.error(`[stderr] ${d}`),
            });
            return proc.stdout || proc.stderr || "Command executed successfully";
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
              // Normalize path - remove /home/user/ if present
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

      // Bind tools to model
      const modelWithTools = model.bindTools([terminalTool, fileWriteTool, readFilesTool]);

      // 4️⃣ Load Previous Messages
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

      // 5️⃣ Build Conversation
      const messages: any[] = [
        { role: "system", content: PROMPT },
        ...previousMessages,
        { role: "user", content: event.data.value },
      ];

      // 6️⃣ Agent Tool-Use Loop
      let iterations = 0;
      const maxIterations = 20;
      let response: any;
      let finalResponse = "";

      console.log("[Agent] Starting tool loop...");

      while (iterations < maxIterations) {
        response = await modelWithTools.invoke(messages);

        // Capture assistant's text response
        if (response.content) {
          finalResponse = typeof response.content === "string" 
            ? response.content 
            : JSON.stringify(response.content);
          messages.push({ role: "assistant", content: finalResponse });
        }

        // Check if there are tool calls
        if (!response.tool_calls?.length) {
          console.log("[Agent] No more tool calls - task complete ✅");
          break;
        }

        // Execute all tool calls
        const toolResults: any[] = [];
        for (const toolCall of response.tool_calls) {
          let toolResult = "";
          
          switch (toolCall.name) {
            case "terminal":
              toolResult = await terminalTool.func(toolCall.args as { command: string });
              break;
            case "createOrUpdateFiles":
              toolResult = await fileWriteTool.func(
                toolCall.args as { files: { path: string; content: string }[] }
              );
              break;
            case "readFiles":
              toolResult = await readFilesTool.func(toolCall.args as { paths: string[] });
              break;
            default:
              toolResult = "Unknown tool";
          }

          toolResults.push({
            role: "tool",
            content: toolResult,
            tool_call_id: toolCall.id,
          });
        }

        messages.push(...toolResults);
        iterations++;
      }

      // If no final response, request summary
      if (!finalResponse.trim()) {
        const summaryResp = await model.invoke([
          ...messages,
          { role: "user", content: "Please summarize what you built." }
        ]);
        finalResponse = typeof summaryResp.content === "string" 
          ? summaryResp.content 
          : JSON.stringify(summaryResp.content);
      }

      // 7️⃣ Read Generated Files
      const generatedFiles = await step.run("read-files", async () => {
        const files: Record<string, string> = {};
        
        // Key files to check
        const filesToRead = [
          "app/page.tsx",
          "app/layout.tsx",
          "tailwind.config.ts",
          "package.json",
        ];

        // Try to list app directory
        try {
          const appFiles = await sandbox!.fs.list("/home/user/app");
          for (const file of appFiles) {
            if (!file.isDir && /\.(tsx?|jsx?|json|html|css)$/.test(file.name)) {
              filesToRead.push(`app/${file.name}`);
            }
          }
        } catch {
          console.log("[Files] Could not list app directory");
        }

        // Try to list root directory for HTML files
        try {
          const rootFiles = await sandbox!.fs.list("/home/user");
          for (const file of rootFiles) {
            if (!file.isDir && /\.html?$/.test(file.name)) {
              filesToRead.push(file.name);
            }
          }
        } catch {
          console.log("[Files] Could not list root directory");
        }

        // Read all files
        for (const filePath of [...new Set(filesToRead)]) {
          try {
            const fullPath = `/home/user/${filePath}`;
            const content = await sandbox!.fs.read(fullPath);
            files[filePath] = content;
            console.log(`[Files] ✅ Read: ${filePath}`);
          } catch {
            // File doesn't exist, skip
          }
        }

        console.log(`[Files] Total files read: ${Object.keys(files).length}`);
        return files;
      });

      // 8️⃣ Determine App Type and Start Server
      const hasHtmlFiles = Object.keys(generatedFiles).some((f) => f.endsWith(".html"));
      const hasNextjsApp = Boolean(
        generatedFiles["app/page.tsx"] && generatedFiles["package.json"]
      );

      let sandboxUrl = "";

      if (hasNextjsApp) {
        // Start Next.js dev server
        await step.run("start-nextjs", async () => {
          console.log("[Server] Starting Next.js dev server...");
          
          sandbox!.process?.start?.({
            cmd: "cd /home/user && npm run dev -- --turbo",
            onStdout: (d: string) => console.log(`[Server] ${d}`),
            onStderr: (d: string) => console.error(`[Server] ${d}`),
          });

          // Wait for server to be ready
          let attempts = 0;
          const maxAttempts = 30;
          
          while (attempts < maxAttempts) {
            try {
              const res = await fetch(`https://${sandbox!.getHost()}/`, { 
                method: "HEAD",
                signal: AbortSignal.timeout(3000)
              });
              if (res.ok) {
                console.log("[Server] ✅ Next.js server is ready");
                break;
              }
            } catch {
              // Retry
            }
            await new Promise((r) => setTimeout(r, 2000));
            attempts++;
          }

          if (attempts >= maxAttempts) {
            console.warn("[Server] ⚠️ Server might not be ready yet");
          }
        });

        sandboxUrl = `https://${sandbox.getHost()}`;
        
      } else if (hasHtmlFiles) {
        // Start HTTP server for HTML files
        await step.run("start-http-server", async () => {
          console.log("[Server] Starting HTTP server for HTML...");
          
          sandbox!.process?.start?.({
            cmd: "cd /home/user && python3 -m http.server 3000",
            onStdout: (d: string) => console.log(`[Server] ${d}`),
            onStderr: (d: string) => console.error(`[Server] ${d}`),
          });

          await new Promise((r) => setTimeout(r, 3000));
        });

        // Find the main HTML file
        const htmlFiles = Object.keys(generatedFiles).filter((f) => f.endsWith(".html"));
        const mainHtmlFile = 
          htmlFiles.find((f) => /index\.html$/i.test(f)) || 
          htmlFiles[0];

        sandboxUrl = `https://${sandbox.getHost()}/${mainHtmlFile}`;
        console.log(`[Server] ✅ HTML server ready: ${sandboxUrl}`);
        
      } else {
        sandboxUrl = `https://${sandbox.getHost()}`;
        console.warn("[Server] ⚠️ No Next.js or HTML files detected");
      }

      // 9️⃣ Save to Database
      await step.run("save-to-db", async () => {
        await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: finalResponse || "✅ App built successfully!",
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
        console.log(`[DB] ✅ Saved with URL: ${sandboxUrl}`);
      });

      // 🔟 Return Result
      return {
        success: true,
        url: sandboxUrl,
        response: finalResponse,
        files: generatedFiles,
        fileCount: Object.keys(generatedFiles).length,
      };

    } catch (err: unknown) {
      const error = err as Error;
      console.error("❌ [Agent Error]:", error);
      
      await prisma.message.create({
        data: {
          projectId: event.data?.projectId ?? "unknown",
          content: `Error: ${error.message}`,
          role: "ASSISTANT",
          type: "ERROR",
        },
      });

      return { 
        error: true, 
        message: error.message,
        stack: error.stack 
      };
      
    } finally {
      // Keep sandbox alive for preview
      console.log("[Sandbox] Keeping sandbox alive for user preview");
    }
  }
);