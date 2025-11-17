import { inngest } from "./client";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import prisma from "@/lib/db";
import { PROMPT } from "@/prompts";
import { Sandbox } from "@e2b/code-interpreter";

const SANDBOX_TEMPLATE_ID = "2kmaga44jttvxphjuxkz";

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
          timeoutMs: 900_000,
          metadata: { projectId: event.data.projectId },
        });
        console.log(`[Sandbox] Created successfully: ${sbx.host}`);
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
      let allAssistantMessages: string[] = [];

      console.log("[Agent] Starting tool loop...");

      while (iterations < maxIterations) {
        response = await modelWithTools.invoke(messages);

        // Capture ALL assistant text responses
        if (response.content) {
          const textContent = typeof response.content === "string" 
            ? response.content 
            : JSON.stringify(response.content);
          
          if (textContent.trim()) {
            allAssistantMessages.push(textContent);
            finalResponse = textContent; // Keep updating with latest
          }
          
          messages.push({ role: "assistant", content: response.content });
        }

        // Add tool calls to messages if present
        if (response.tool_calls?.length) {
          messages.push({
            role: "assistant",
            content: "",
            tool_calls: response.tool_calls
          });
        }

        // Check if there are tool calls
        if (!response.tool_calls?.length) {
          console.log("[Agent] No more tool calls - task complete ✅");
          break;
        }

        // Execute all tool calls
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

          messages.push({
            role: "tool",
            content: toolResult,
            tool_call_id: toolCall.id,
          });
        }

        iterations++;
      }

      // If no final response, request summary
      if (!finalResponse.trim()) {
        console.log("[Agent] No final response, requesting summary...");
        const summaryResp = await model.invoke([
          ...messages,
          { role: "user", content: "Please provide a brief summary of what you've built and any important details." }
        ]);
        finalResponse = typeof summaryResp.content === "string" 
          ? summaryResp.content 
          : JSON.stringify(summaryResp.content);
        allAssistantMessages.push(finalResponse);
      }

      // Combine all assistant messages for a complete response
      const completeResponse = allAssistantMessages.join("\n\n");

      // 7️⃣ Read Generated Files
      const generatedFiles = await step.run("read-files", async () => {
        const files: Record<string, string> = {};
        
        const filesToRead = [
          "app/page.tsx",
          "app/layout.tsx",
          "tailwind.config.ts",
          "package.json",
        ];

        // List app directory
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

        // List root directory
        try {
          const rootFiles = await sandbox!.fs.list("/home/user");
          for (const file of rootFiles) {
            if (!file.isDir && /\.(html?|tsx?|jsx?|json|css)$/.test(file.name)) {
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
        await step.run("start-nextjs", async () => {
          console.log("[Server] Starting Next.js dev server...");
          
          // Kill any existing processes on port 3000
          try {
            await sandbox!.commands.run("lsof -ti:3000 | xargs kill -9 || true");
          } catch {
            // Ignore errors
          }
          
          sandbox!.process?.start?.({
            cmd: "cd /home/user && npm run dev -- --turbo --port 3000",
            onStdout: (d: string) => console.log(`[Server] ${d}`),
            onStderr: (d: string) => console.error(`[Server] ${d}`),
          });

          // Wait for server with better error handling
          let attempts = 0;
          const maxAttempts = 40; // Increase attempts
          
          while (attempts < maxAttempts) {
            try {
              const res = await fetch(`https://${sandbox!.host}/`, { 
                method: "HEAD",
                signal: AbortSignal.timeout(5000)
              });
              if (res.ok) {
                console.log("[Server] ✅ Next.js server is ready");
                return;
              }
            } catch (err) {
              console.log(`[Server] Attempt ${attempts + 1}/${maxAttempts}...`);
            }
            await new Promise((r) => setTimeout(r, 3000));
            attempts++;
          }

          console.warn("[Server] ⚠️ Server may not be fully ready yet, but continuing...");
        });

        sandboxUrl = `https://${sandbox.host}`;
        
      } else if (hasHtmlFiles) {
        await step.run("start-http-server", async () => {
          console.log("[Server] Starting HTTP server for HTML...");
          
          // Kill any existing processes on port 3000
          try {
            await sandbox!.commands.run("lsof -ti:3000 | xargs kill -9 || true");
          } catch {
            // Ignore errors
          }
          
          sandbox!.process?.start?.({
            cmd: "cd /home/user && python3 -m http.server 3000",
            onStdout: (d: string) => console.log(`[Server] ${d}`),
            onStderr: (d: string) => console.error(`[Server] ${d}`),
          });

          await new Promise((r) => setTimeout(r, 5000)); // Give it more time
        });

        const htmlFiles = Object.keys(generatedFiles).filter((f) => f.endsWith(".html"));
        const mainHtmlFile = 
          htmlFiles.find((f) => /index\.html$/i.test(f)) || 
          htmlFiles[0];

        sandboxUrl = mainHtmlFile 
          ? `https://${sandbox.host}:3000/${mainHtmlFile}`
          : `https://${sandbox.host}:3000`;
        console.log(`[Server] ✅ HTML server ready: ${sandboxUrl}`);
        
      } else {
        sandboxUrl = `https://${sandbox.host}`;
        console.warn("[Server] ⚠️ No Next.js or HTML files detected");
      }

      // 9️⃣ Save to Database
      await step.run("save-to-db", async () => {
        const messageContent = completeResponse || finalResponse || "✅ App built successfully!";
        
        await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: messageContent,
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
        console.log(`[DB] ✅ Saved message with ${messageContent.length} chars`);
        console.log(`[DB] ✅ Sandbox URL: ${sandboxUrl}`);
        console.log(`[DB] ✅ Files saved: ${Object.keys(generatedFiles).length}`);
      });

      // 🔟 Return Result
      return {
        success: true,
        url: sandboxUrl,
        response: completeResponse || finalResponse,
        files: generatedFiles,
        fileCount: Object.keys(generatedFiles).length,
      };

    } catch (err: unknown) {
      const error = err as Error;
      console.error("❌ [Agent Error]:", error);
      
      await prisma.message.create({
        data: {
          projectId: event.data?.projectId ?? "unknown",
          content: `Error: ${error.message}\n\nStack: ${error.stack}`,
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
      console.log("[Sandbox] Keeping sandbox alive for user preview");
    }
  }
);