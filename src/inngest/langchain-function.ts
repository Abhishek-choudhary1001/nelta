import { Inngest } from "inngest";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import prisma from "@/lib/db";
import { PROMPT } from "@/prompts";
import { Sandbox } from "@e2b/code-interpreter";

// ✅ Create inngest client
export const inngest = new Inngest({ id: "my-app" });

// ✅ Define event function
export const codeAgentFunction = inngest.createFunction(
  { id: "langchain-code-agent", retries: 0 },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    // ✅ Type-safe sandbox fallback
    const sandboxFallback: Sandbox = {
      commands: {} as any,
      process: {} as any,
      fs: {} as any,
      getHost: () => "localhost",
    } as Sandbox;

    let sandbox: Sandbox = sandboxFallback;

    try {
      // 🏗️ Create sandbox
      // @ts-expect-error: sandbox fallback is a loose mock, real Sandbox is created later
      sandbox = await step.run("create-sandbox", async () => {
        console.log("[Sandbox] Creating...");
        const sbx = await Sandbox.create("k0wmnzir0zuzye6dndlw", {
          timeoutMs: 600000,
          metadata: { projectId: event.data.projectId },
        });
        console.log(`[Sandbox] Created: ${sbx.getHost()}`);
        return sbx;
      });

      // 🧠 Initialize model
      const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL ?? "qwen/qwen3-coder:free",
        openAIApiKey: process.env.OPENROUTER_API_KEY,
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
        temperature: 0.7,
      });

      // 🧰 Tool: Terminal
      const terminalTool = new DynamicStructuredTool({
        name: "terminal",
        description: "Run terminal commands inside sandbox",
        schema: z.object({ command: z.string() }),
        func: async ({ command }) => {
          console.log(`[Tool: terminal] ${command}`);
          try {
            const proc = await sandbox.commands.run(command, {
              onStdout: (d: string) => console.log(`[stdout] ${d}`),
              onStderr: (d: string) => console.error(`[stderr] ${d}`),
            });

            const output =
              (proc.output as any)?.stdout ??
              (proc.output as any)?.stderr ??
              "Command executed successfully";
            return output;
          } catch (error: unknown) {
            if (error instanceof Error) return `Error: ${error.message}`;
            return "Unknown error while running command";
          }
        },
      });

      // 🧰 Tool: File Writer
      const fileWriteTool = new DynamicStructuredTool({
        name: "createOrUpdateFiles",
        description: "Write or update files in sandbox",
        schema: z.object({
          files: z.array(z.object({ path: z.string(), content: z.string() })),
        }),
        func: async ({ files }) => {
          console.log(`[Tool] Writing ${files.length} file(s)`);
          try {
            for (const file of files) {
              const fullPath = file.path.startsWith("/home/user/")
                ? file.path
                : `/home/user/${file.path}`;
              await sandbox.fs.write(fullPath, file.content);
              console.log(`[Tool] Wrote: ${fullPath}`);
            }
            return `✅ Wrote ${files.length} files`;
          } catch (error: unknown) {
            if (error instanceof Error)
              return `Error writing files: ${error.message}`;
            return "Unknown error writing files";
          }
        },
      });

      // 🧰 Tool: File Reader
      const readFilesTool = new DynamicStructuredTool({
        name: "readFiles",
        description: "Read files from sandbox",
        schema: z.object({ paths: z.array(z.string()) }),
        func: async ({ paths }) => {
          const results: Record<string, string> = {};
          try {
            for (const path of paths) {
              const fullPath = path.startsWith("/home/user/")
                ? path
                : `/home/user/${path}`;
              const content = await sandbox.fs.read(fullPath);
              results[path] = content;
            }
            return JSON.stringify(results, null, 2);
          } catch (error: unknown) {
            if (error instanceof Error)
              return `Error reading files: ${error.message}`;
            return "Unknown error reading files";
          }
        },
      });

      // 🧩 Bind tools
      const modelWithTools = model.bindTools([
        terminalTool,
        fileWriteTool,
        readFilesTool,
      ]);

      // 💬 Load messages
      const previousMessages = await step.run("load-msgs", async () => {
        const msgs = await prisma.message.findMany({
          where: { projectId: event.data.projectId },
          orderBy: { createdAt: "asc" },
          take: 10,
        });
        return msgs.map((m) => ({
          role: m.role === "ASSISTANT" ? "assistant" : "user",
          content: m.content ?? "",
        }));
      });

      const messages: any[] = [
        { role: "system", content: PROMPT },
        ...previousMessages,
        { role: "user", content: event.data.value },
      ];

      // 🔁 Tool Loop
      let iterations = 0;
      const maxIterations = 20;
      let response: any;

      while (iterations < maxIterations) {
        response = await modelWithTools.invoke(messages);
        
        // Add the assistant's response to messages (including tool calls)
        messages.push(response);

        // If no tool calls, break the loop
        if (!response.tool_calls?.length) break;

        const toolResults: any[] = [];

        // Execute tool calls
        for (const toolCall of response.tool_calls) {
          let result: string;
          
          switch (toolCall.name) {
            case "terminal": {
              result = await terminalTool.func(
                toolCall.args as { command: string }
              );
              break;
            }
            case "createOrUpdateFiles": {
              result = await fileWriteTool.func(
                toolCall.args as {
                  files: { path: string; content: string }[];
                }
              );
              break;
            }
            case "readFiles": {
              result = await readFilesTool.func(
                toolCall.args as { paths: string[] }
              );
              break;
            }
            default:
              result = "Unknown tool";
          }

          toolResults.push({
            role: "tool",
            content: result,
            tool_call_id: toolCall.id,
          });
        }

        // Add tool results to messages
        messages.push(...toolResults);
        iterations++;
      }

      // 🎯 Get final response after tool loop completes
      let finalResponse = "";
      if (response?.content) {
        if (typeof response.content === "string") {
          finalResponse = response.content;
        } else if (Array.isArray(response.content)) {
          // Handle content blocks
          finalResponse = response.content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("\n");
        } else {
          finalResponse = JSON.stringify(response.content);
        }
      }

      // If no content in final response, ask model to summarize
      if (!finalResponse || finalResponse.trim().length === 0) {
        messages.push({
          role: "user",
          content: "Please provide a summary of what you've built and any important details.",
        });
        const summaryResponse = await model.invoke(messages);
        finalResponse = typeof summaryResponse.content === "string" 
          ? summaryResponse.content 
          : JSON.stringify(summaryResponse.content);
      }

      // 📁 Read Generated Files BEFORE starting server
      const generatedFiles = await step.run("get-files", async () => {
        const files: Record<string, string> = {};
        try {
          const filesToRead = [
            "app/page.tsx",
            "app/layout.tsx",
            "tailwind.config.ts",
            "package.json",
          ];
          
          // Try to list files in app directory
          try {
            const appFiles = await sandbox.fs.list("/home/user/app");
            for (const file of appFiles) {
              const isDir = (file as any).isDir ?? false;
              if (!isDir && file.name.match(/\.(tsx?|jsx?|css|json|html|css)$/)) {
                filesToRead.push(`app/${file.name}`);
              }
            }
          } catch (err) {
            console.log("[Files] Could not list app directory");
          }

          // Also check for standalone HTML files (for simple demos)
          try {
            const rootFiles = await sandbox.fs.list("/home/user");
            for (const file of rootFiles) {
              const isDir = (file as any).isDir ?? false;
              if (!isDir && file.name.match(/\.(html|htm)$/)) {
                filesToRead.push(file.name);
              }
            }
          } catch (err) {
            console.log("[Files] Could not list root directory");
          }

          // Read all files
          for (const path of filesToRead) {
            try {
              const fullPath = path.startsWith("/home/user/")
                ? path
                : `/home/user/${path}`;
              const content = await sandbox.fs.read(fullPath);
              files[path] = content;
              console.log(`[Files] Read: ${path}`);
            } catch {
              // ignore missing files
            }
          }
        } catch (err: unknown) {
          if (err instanceof Error) console.error("[Files] Error:", err.message);
        }
        return files;
      });

      // 🚀 Start Next.js Dev Server (or detect simple HTML)
      let sandboxUrl = "";
      const hasHtmlFiles = Object.keys(generatedFiles).some(f => f.endsWith('.html'));
      const hasNextjsApp = generatedFiles["app/page.tsx"] || generatedFiles["package.json"];

      if (hasNextjsApp) {
        // Start Next.js server
        await step.run("start-server", async () => {
          console.log("[Sandbox] Starting Next.js dev server...");
          sandbox.process?.start?.({
            cmd: "cd /home/user && npm run dev",
            onStdout: (d: string) => console.log(`[Server] ${d}`),
            onStderr: (d: string) => console.error(`[Server] ${d}`),
          });

          let attempts = 0;
          const maxAttempts = 30;
          while (attempts < maxAttempts) {
            try {
              const res = await fetch(`https://${sandbox.getHost()}/`, {
                method: "HEAD",
              });
              if (res.ok) {
                console.log("[Server] Next.js dev server is ready!");
                break;
              }
            } catch {
              // retry
            }
            await new Promise((r) => setTimeout(r, 2000));
            attempts++;
          }
          
          if (attempts >= maxAttempts) {
            console.warn("[Server] Server might not be ready yet");
          }
        });
        sandboxUrl = `https://${sandbox.getHost()}`;
      } else if (hasHtmlFiles) {
        // For simple HTML files, use Python HTTP server
        await step.run("start-html-server", async () => {
          console.log("[Sandbox] Starting HTTP server for HTML files...");
          sandbox.process?.start?.({
            cmd: "cd /home/user && python3 -m http.server 3000",
            onStdout: (d: string) => console.log(`[Server] ${d}`),
            onStderr: (d: string) => console.error(`[Server] ${d}`),
          });

          await new Promise((r) => setTimeout(r, 3000)); // Wait for server to start
        });
        
        // Find the main HTML file
        const mainHtmlFile = Object.keys(generatedFiles).find(f => 
          f === 'index.html' || f.endsWith('index.html')
        ) || Object.keys(generatedFiles).find(f => f.endsWith('.html'));
        
        const htmlPath = mainHtmlFile ? `/${mainHtmlFile.replace('/home/user/', '')}` : '';
        sandboxUrl = `https://${sandbox.getHost()}${htmlPath}`;
      } else {
        // No recognizable app structure
        sandboxUrl = `https://${sandbox.getHost()}`;
        console.warn("[Server] No Next.js or HTML files detected");
      }

      // 💾 Save to DB with proper structure for demo section
      await step.run("save-result", async () => {
        await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: finalResponse || "✅ App built successfully!",
            role: "ASSISTANT",
            type: "RESULT",
            fragment: {
              create: {
                sandboxUrl: sandboxUrl,
                title: "Generated App",
                files: generatedFiles,
              },
            },
          },
        });
        console.log(`[DB] Saved message with sandbox URL: ${sandboxUrl}`);
        console.log(`[DB] Saved ${Object.keys(generatedFiles).length} files`);
      });

      return {
        success: true,
        url: sandboxUrl,
        response: finalResponse,
        files: generatedFiles,
        fileCount: Object.keys(generatedFiles).length,
      };
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("❌ [Agent Error]:", err);
        await prisma.message.create({
          data: {
            projectId: event.data?.projectId ?? "unknown",
            content: `Error: ${err.message}`,
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
        return { error: true, message: err.message };
      }
      return { error: true, message: "Unknown error occurred" };
    } finally {
      console.log("[Sandbox] Keeping sandbox alive for preview");
      // Don't kill the sandbox - keep it running for the demo!
    }
  }
);