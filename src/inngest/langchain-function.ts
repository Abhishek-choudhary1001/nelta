// src/inngest/langchain-functions.ts
import { Inngest } from "inngest";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import prisma from "@/lib/db";
import { PROMPT } from "@/prompts";

export const inngest = new Inngest({ id: "my-app" });

interface AgentState {
  messages: Array<{ role: string; content: string }>;
  files: Record<string, string>;
}

// Mock Sandbox
class MockSandbox {
  files: Record<string, string> = {};
  
  async runCommand(command: string) {
    console.log(`[Sandbox] Running: ${command}`);
    return { stdout: `Executed: ${command}` };
  }
  
  async writeFile(path: string, content: string) {
    this.files[path] = content;
  }
  
  getHost() { return "localhost:3000"; }
}

export const codeAgentFunction = inngest.createFunction(
  { id: "langchain-code-agent", retries: 0 },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    try {
      const sandbox = new MockSandbox();
      
      // Initialize LangChain model
      const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL || "qwen/qwen3-coder:free",
        openAIApiKey: process.env.OPENROUTER_API_KEY,
        configuration: {
          baseURL: "https://openrouter.ai/api/v1",
        },
        temperature: 0.7,
      });

      // Define tools
      const terminalTool = new DynamicStructuredTool({
        name: "terminal",
        description: "Run terminal commands in sandbox",
        schema: z.object({
          command: z.string().describe("The command to run"),
        }),
        func: async ({ command }) => {
          const result = await sandbox.runCommand(command);
          return result.stdout;
        },
      });

      const fileWriteTool = new DynamicStructuredTool({
        name: "createOrUpdateFiles",
        description: "Write or update files in sandbox",
        schema: z.object({
          files: z.array(
            z.object({
              path: z.string(),
              content: z.string(),
            })
          ),
        }),
        func: async ({ files }) => {
          for (const file of files) {
            await sandbox.writeFile(file.path, file.content);
          }
          return `Updated ${files.length} file(s)`;
        },
      });

      // Bind tools to model
      const modelWithTools = model.bindTools([terminalTool, fileWriteTool]);

      // Load previous messages
      const previousMessages = await step.run("load-msgs", async () => {
        const msgs = await prisma.message.findMany({
          where: { projectId: event.data.projectId },
          orderBy: { createdAt: "asc" },
          take: 5,
        });
        return msgs.map(m => ({
          role: m.role === "ASSISTANT" ? "assistant" : "user",
          content: m.content ?? "",
        }));
      });

      // Build conversation
      const messages = [
        { role: "system", content: PROMPT },
        ...previousMessages,
        { role: "user", content: event.data.value },
      ];

      // Run agent loop
      let iterations = 0;
      const maxIterations = 15;
      let response;

      while (iterations < maxIterations) {
        response = await modelWithTools.invoke(messages);
        
        // Check if tool calls exist
        if (!response.tool_calls || response.tool_calls.length === 0) {
          break; // Agent finished
        }

        // Execute tool calls
        for (const toolCall of response.tool_calls) {
            if (toolCall.name === "terminal") {
              const result = await terminalTool.func(toolCall.args as { command: string });
              messages.push({
                role: "tool",
                content: result,
                tool_call_id: toolCall.id,
              } as any);
            } else if (toolCall.name === "createOrUpdateFiles") {
              const result = await fileWriteTool.func(
                toolCall.args as { files: { path: string; content: string }[] }
              );
              messages.push({
                role: "tool",
                content: result,
                tool_call_id: toolCall.id,
              } as any);
            }
          }
          

        iterations++;
      }

      // Save result
      const finalResponse = response?.content || "Done";
      const sandboxUrl = `http://${sandbox.getHost()}`;

      await step.run("save-result", async () => {
        return prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: String(finalResponse),
            role: "ASSISTANT",
            type: "RESULT",
            fragment: {
              create: {
                sandboxUrl,
                title: "Generated App",
                files: sandbox.files,
              },
            },
          },
        });
      });

      return { url: sandboxUrl, files: sandbox.files };

    } catch (err: any) {
      console.error("Error:", err);
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
  }
);