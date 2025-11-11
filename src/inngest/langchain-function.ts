import { Inngest } from "inngest";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import prisma from "@/lib/db";
import { PROMPT } from "@/prompts";
import fs from "fs";
import path from "path";

// Initialize Inngest client
export const inngest = new Inngest({ id: "my-app" });

/* -------------------------------------------------------------------------- */
/*                          🧱 Mock Sandbox Class                              */
/* -------------------------------------------------------------------------- */

class MockSandbox {
  files: Record<string, string> = {};

  async runCommand(command: string) {
    console.log(`[Sandbox] Running: ${command}`);
    return { stdout: `Executed: ${command}` };
  }

  async writeFile(filePath: string, content: string) {
    const normalizedPath = filePath
      .replace(/^\/home\/user\//, "")
      .replace(/^\//, "");
    this.files[normalizedPath] = content;
    console.log(`[Sandbox] Wrote file: ${normalizedPath}`);
  }

  async writeMultipleFiles(files: { path: string; content: string }[]) {
    for (const file of files) {
      await this.writeFile(file.path, file.content);
    }
  }

  getAllFiles() {
    return { ...this.files };
  }
}

/* -------------------------------------------------------------------------- */
/*                   🗂 Write Generated Files to /public/previews              */
/* -------------------------------------------------------------------------- */

async function writeFilesToPublic(projectId: string, files: Record<string, string>) {
  const baseDir = path.join(process.cwd(), "public", "previews", projectId);
  await fs.promises.mkdir(baseDir, { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const targetPath = path.join(baseDir, filePath);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, content, "utf8");
  }

  // ✅ Detect correct HTML entrypoint
  const htmlFiles = Object.keys(files).filter((f) => f.endsWith(".html"));
  let entryFile = "index.html";

  if (htmlFiles.length > 0) {
    entryFile = htmlFiles.find((f) => /index\.html$/i.test(f)) ?? htmlFiles[0];
  }

  const host = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const previewUrl = `${host}/previews/${projectId}/${entryFile}`;
  console.log(`[Preview] Files saved at: ${previewUrl}`);

  return previewUrl;
}

/* -------------------------------------------------------------------------- */
/*                             ⚙️ Main Inngest Function                        */
/* -------------------------------------------------------------------------- */

export const codeAgentFunction = inngest.createFunction(
  { id: "langchain-code-agent", retries: 0 },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    try {
      const sandbox = new MockSandbox();

      // 🧠 Initialize LLM model via LangChain
      const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL || "minimax/minimax-m2:free",
        openAIApiKey: process.env.OPENROUTER_API_KEY,
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
        temperature: 0.7,
      });

      /* ------------------------------- 🧰 Tools ------------------------------ */

      const terminalTool = new DynamicStructuredTool({
        name: "terminal",
        description: "Run terminal commands in sandbox (e.g., npm install). Returns command output.",
        schema: z.object({ command: z.string() }),
        func: async ({ command }) => {
          console.log(`[Tool: terminal] ${command}`);
          const result = await sandbox.runCommand(command);
          return result.stdout;
        },
      });

      const fileWriteTool = new DynamicStructuredTool({
        name: "createOrUpdateFiles",
        description: "Write or update files in the sandbox. Provide an array of {path, content} objects.",
        schema: z.object({
          files: z.array(
            z.object({
              path: z.string(),
              content: z.string(),
            })
          ),
        }),
        func: async ({ files }) => {
          console.log(`[Tool: createOrUpdateFiles] Writing ${files.length} file(s)`);
          await sandbox.writeMultipleFiles(files);
          const paths = files.map((f) => f.path).join(", ");
          return `Successfully wrote ${files.length} file(s): ${paths}`;
        },
      });

      const modelWithTools = model.bindTools([terminalTool, fileWriteTool]);

      /* ---------------------------- 🧾 Load Messages ---------------------------- */
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

      const messages = [
        { role: "system", content: PROMPT },
        ...previousMessages,
        { role: "user", content: event.data.value },
      ];

      /* ------------------------ 🔁 Iterative Tool Loop ------------------------ */

      let iterations = 0;
      const maxIterations = 20;
      let response;
      let lastTextContent = "";

      while (iterations < maxIterations) {
        console.log(`[Agent] Iteration ${iterations + 1}/${maxIterations}`);
        response = await modelWithTools.invoke(messages);

        if (response.content) {
          lastTextContent =
            typeof response.content === "string"
              ? response.content
              : response.content.toString();
        }

        if (!response.tool_calls || response.tool_calls.length === 0) {
          console.log("[Agent] No more tool calls — task complete ✅");
          break;
        }

        const toolResults: any[] = [];

        for (const toolCall of response.tool_calls) {
          console.log(`[Agent] Executing tool: ${toolCall.name}`);

          if (toolCall.name === "terminal") {
            const result = await terminalTool.func(toolCall.args as { command: string });
            toolResults.push({ role: "tool", content: result, tool_call_id: toolCall.id });
          } else if (toolCall.name === "createOrUpdateFiles") {
            const result = await fileWriteTool.func(toolCall.args as { files: { path: string; content: string }[] });
            toolResults.push({ role: "tool", content: result, tool_call_id: toolCall.id });
          }
        }

        messages.push({ role: "assistant", content: lastTextContent || "" } as any);
        messages.push(...toolResults);
        iterations++;
      }

      /* -------------------------- 💾 Save Generated Files -------------------------- */

      const generatedFiles = sandbox.getAllFiles();
      const fileCount = Object.keys(generatedFiles).length;
      console.log(`[Agent] Completed with ${fileCount} file(s) generated`);

      const sandboxUrl = await writeFilesToPublic(event.data.projectId, generatedFiles);
      const finalResponse = lastTextContent || "✅ Application built successfully!";

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
                files: generatedFiles,
              },
            },
          },
        });
      });

      /* ------------------------------ 🎯 Return Result ------------------------------ */

      return {
        success: true,
        url: sandboxUrl,
        files: generatedFiles,
        fileCount,
      };
    } catch (err: any) {
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
  }
);
