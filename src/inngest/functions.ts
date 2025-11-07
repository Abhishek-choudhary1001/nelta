// src/inngest/functions.ts
import { Inngest } from "inngest";
import { createAgent, createTool, createNetwork, createState } from "@inngest/agent-kit";
import { getSandbox, lastAssistantTextMessageContent } from "./utils";
import { z } from "zod";
import prisma from "@/lib/db";
import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/prompts";
import { SANDBOX_TIMEOUT } from "./types";
import { OpenRouter } from "@openrouter/sdk";

export const inngest = new Inngest({ id: "my-app" });

interface AgentState {
  summary: string;
  files: Record<string, string>;
}

function logDivider(label: string) {
  console.log(`\n================= 🧩 ${label} =================`);
}

function getTextFromMessage(m: any): string {
  if (!m) return "";
  if (typeof m === "string") return m;
  if ("content" in m && typeof m.content === "string") return m.content;
  if (Array.isArray(m) && m[0] && "content" in m[0]) return String(m[0].content);
  return String(m);
}

// Initialize OpenRouter client
const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

// ======= Mock Sandbox =======
class MockSandbox {
  sandboxId = "mock-sandbox-123";
  files: Record<string, string> = {};

  async setTimeout(_ms: number) {}
  async runCommand(command: string) {
    console.log(`[MockSandbox] Running command: ${command}`);
    return { stdout: `Executed: ${command}`, stderr: "" };
  }
  async writeFile(path: string, content: string) {
    console.log(`[MockSandbox] Writing file: ${path}`);
    this.files[path] = content;
  }
  getHost(_port: number) {
    return "localhost:3000";
  }
}

type SandboxType = MockSandbox;

async function createMockSandbox(): Promise<SandboxType> {
  const s = new MockSandbox();
  await s.setTimeout(SANDBOX_TIMEOUT);
  console.log("✅ [MockSandbox] Created:", s.sandboxId);
  return s;
}

// ===========================

export const codeAgentFunction = inngest.createFunction(
  { id: "my-app-code-agent", retries: 0 },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    console.log("\n🚀 [START] codeAgentFunction triggered");

    try {
      if (!event.data?.projectId) throw new Error("Missing projectId in event.data");

      // 🧱 Sandbox setup
      logDivider("Sandbox Setup");
      const sandbox = (await step.run("create-sandbox", async () => createMockSandbox())) as MockSandbox;

      // 💬 Load previous messages
      logDivider("Load Previous Messages");
      const previousMessages = await step.run("get-prev-msgs", async () => {
        const msgs = await prisma.message.findMany({
          where: { projectId: event.data.projectId },
          orderBy: { createdAt: "asc" },
          take: 5,
        });
        console.log("🗨️ [DB] Found previous messages:", msgs.length);
        return msgs.map((m) => ({
          role: m.role === "ASSISTANT" ? "assistant" : "user",
          content: m.content ?? "",
        }));
      });

      // 🧠 Initialize state
      logDivider("Initialize State");
      const state = createState<AgentState>({ summary: "", files: {} }, { messages: previousMessages as any });

      // 🤖 Model setup (OpenRouter wrapper with .request())
      logDivider("Model Setup");
      const model = {
        request: async (messages: string | { role: string; content: string }[]) => {
          const msgs = Array.isArray(messages)
            ? messages.map((m) => ({ role: m.role as any, content: m.content }))
            : [{ role: "user", content: messages }];

          const completion = await openRouter.chat.send({
            model: process.env.LLM_MODEL ?? "qwen/qwen3-coder:free",
            messages: msgs,
            stream: false,
          });

          return {
            output: completion.choices.map((c: any) => ({
              role: c.message?.role ?? "assistant",
              content: c.message?.content ?? "",
            })),
          };
        },
      } as any;

      console.log("✅ [Model] Using OpenRouter model");

      // 🧩 Agent setup
      logDivider("Agent Setup");
      const codeAgent = createAgent<AgentState>({
        name: "code-agent",
        description: "Expert coding agent",
        system: PROMPT,
        model,
        tools: [
          createTool({
            name: "terminal",
            description: "Run terminal commands in sandbox",
            parameters: z.object({ command: z.string() }),
            handler: async ({ command }) => {
              const result = await sandbox.runCommand(command);
              return result.stdout || result.stderr || "Command completed";
            },
          }),
          createTool({
            name: "createOrUpdateFiles",
            description: "Write files to sandbox",
            parameters: z.object({
              files: z.array(z.object({ path: z.string(), content: z.string() })),
            }),
            handler: async ({ files }, context) => {
              const updated: Record<string, string> = {};
              for (const file of files) {
                await sandbox.writeFile(file.path, file.content);
                updated[file.path] = file.content;
              }
              if (context?.network?.state?.data?.files) {
                context.network.state.data.files = {
                  ...context.network.state.data.files,
                  ...updated,
                };
              }
              return `Successfully updated ${files.length} file(s)`;
            },
          }),
        ],
        lifecycle: {
          onResponse: async ({ result, network }) => {
            const text = lastAssistantTextMessageContent(result);
            if (text?.includes("<task_summary>") && network) {
              network.state.data.summary = text;
            }
            return result;
          },
        },
      });

      // 🌐 Network setup
      logDivider("Network Setup");
      const network = createNetwork<AgentState>({
        name: "coding-agent-network",
        agents: [codeAgent],
        maxIter: 15,
        defaultState: state,
        router: async () => codeAgent,
      });

      // 🚀 Network execution
      logDivider("Network Execution");
      const userPrompt = event.data?.value ?? "Generate a simple app";

      let result;
      try {
        console.log("🚦 [Network] Starting execution with prompt:", userPrompt);
        result = await network.run(userPrompt, { state });
        console.log("✅ [Network] Execution completed");
      } catch (err: any) {
        console.error("❌ [Network.run Error]", err);
        await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: `Network.run failed: ${String(err.message || err)}`,
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
        return { error: true, message: `Network.run failed: ${String(err.message || err)}` };
      }

      // 📦 Postprocessing
      logDivider("Postprocessing & Response");
      const summaryInput = result?.state?.data?.summary ?? "";

      // Title & Response Agents
      const fragmentTitleAgent = createAgent({
        name: "fragment-title",
        system: FRAGMENT_TITLE_PROMPT,
        model,
      });
      const responseGeneratorAgent = createAgent({
        name: "response-generator",
        system: RESPONSE_PROMPT,
        model,
      });

      // ======= IMPORTANT FIX: use .run() on the agents (not .request) =======
      const fragResult = await step.run("generate-title", async () =>
        fragmentTitleAgent.run(summaryInput || FRAGMENT_TITLE_PROMPT)
      );
      
      const respResult = await step.run("generate-response", async () =>
        responseGeneratorAgent.run(summaryInput || RESPONSE_PROMPT)
      );
      

      const fragmentTitle = getTextFromMessage(fragResult?.output?.[0]) || "Fragment";
      const responseText = getTextFromMessage(respResult?.output?.[0]) || "Here you go";

      const sandboxUrl = await step.run("get-sandbox-url", async () => `http://${sandbox.getHost(3000)}`);

      await step.run("save-result", async () => {
        return prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: responseText,
            role: "ASSISTANT",
            type: "RESULT",
            fragment: { create: { sandboxUrl, title: fragmentTitle, files: result.state.data.files } },
          },
        });
      });

      return { url: sandboxUrl, title: fragmentTitle, files: result.state.data.files, summary: summaryInput };
    } catch (err: any) {
      console.error("💥 [FATAL ERROR]", err);
      await prisma.message.create({
        data: {
          projectId: event.data?.projectId ?? "unknown",
          content: `Error: ${String(err.message ?? err)}`,
          role: "ASSISTANT",
          type: "ERROR",
        },
      });
      return { error: true, message: String(err.message ?? err) };
    }
  }
);
