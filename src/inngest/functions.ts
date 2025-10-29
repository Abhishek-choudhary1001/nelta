import { Inngest } from "inngest";
import {
  createAgent,
  createTool,
  createNetwork,
  type Tool,
  type Message as InngestMessage,
  createState,
} from "@inngest/agent-kit";
import { openrouter } from "@/lib/openrouter";
import { Sandbox } from "@e2b/code-interpreter";
import { getSandbox, lastAssistantTextMessageContent } from "./utils";
import { z } from "zod";
import prisma from "@/lib/db";
import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/prompts";
import { SANDBOX_TIMEOUT } from "./types";

function getTextFromMessage(m: any): string {
  if (!m) return "";
  if (typeof m === "string") return m;
  if ("content" in m && typeof m.content === "string") return m.content;
  if (Array.isArray(m.output) && m.output[0] && "content" in m.output[0]) {
    return String(m.output[0].content);
  }
  return "";
}

function normalizeToMessages(input: any) {
  if (Array.isArray(input)) {
    return input.map((it) => {
      if (typeof it === "string") return { role: "user", content: it };
      if ("content" in it) return { role: it.role ?? "user", content: it.content };
      return { role: it.role ?? "user", content: JSON.stringify(it) };
    });
  }
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (input && input.messages && Array.isArray(input.messages)) return normalizeToMessages(input.messages);
  return [{ role: "user", content: String(input ?? "") }];
}

export const inngest = new Inngest({ id: "my-app" });

interface AgentState {
  summary: string;
  files: Record<string, string>;
}

export const codeAgentFunction = inngest.createFunction(
  { id: "my-app-code-agent" },
  { event: "code-agent/run" },

  async ({ event, step }) => {
    console.log("🚀 [START] codeAgentFunction triggered, event.data:", event.data ?? {});
    try {
      if (!event.data?.projectId) {
        throw new Error("Missing projectId in event.data");
      }

      // -- Create Sandbox
      const sandboxId = await step.run("create-sandbox", async () => {
        const s = await Sandbox.create("nlhz8vlwyupq845jsdg9");
        await s.setTimeout(SANDBOX_TIMEOUT);
        return s.sandboxId;
      });

      // -- Previous Messages
      const previousMessages = await step.run("get-prev-msgs", async () => {
        const msgs = await prisma.message.findMany({
          where: { projectId: event.data.projectId },
          orderBy: { createdAt: "asc" },
          take: 5,
        });
        return msgs.map((m) => ({
          role: m.role === "ASSISTANT" ? "assistant" : "user",
          content: m.content ?? "",
        })) as InngestMessage[];
      });

      const state = createState<AgentState>(
        { summary: "", files: {} },
        { messages: previousMessages as any }
      );

      // -- Model Runner
      async function modelRunner(input: any, modelName = (process.env.LLM_MODEL ?? "qwen/qwen3-coder:free")) {
        try {
          const client = openrouter({ model: modelName });
          const messages = normalizeToMessages(input);
          const responseText = await client.chat({ messages });
          return [{ role: "assistant", content: responseText }];
        } catch (err: any) {
          return [{ role: "assistant", content: `Model error: ${String(err?.message ?? err)}` }];
        }
      }

      // -- Agent + Tools
      const codeAgent = createAgent<AgentState>({
        name: "code-agent",
        description: "An expert coding agent",
        system: PROMPT,
        model: {
          run: async (input: any) => modelRunner(input, "qwen/qwen3-coder:free"),
        } as any,
        tools: [
          createTool({
            name: "terminal",
            description: "Run terminal commands in sandbox",
            parameters: z.object({ command: z.string() }),
            handler: async ({ command }, context) => {
              const { step } = context;
              if (!step || typeof step.run !== "function") {
                return "Error: No step context for terminal command";
              }
              return await step.run("terminal", async () => {
                try {
                  const sbox = await getSandbox(sandboxId);
                  const result = await sbox.commands.run(command, {
                    onStdout: () => {},
                    onStderr: () => {},
                  });
                  return result.stdout;
                } catch (e) {
                  return `Command failed: ${String(e)}`;
                }
              });
            },
          }),
          createTool({
            name: "createOrUpdateFiles",
            description: "Write files to sandbox",
            parameters: z.object({
              files: z.array(z.object({ path: z.string(), content: z.string() })),
            }),
            handler: async ({ files }, context) => {
              const { step, network } = context;
              if (!step || typeof step.run !== "function") {
                return {};
              }
              const newFiles = await step.run("create-files", async () => {
                try {
                  const sbox = await getSandbox(sandboxId);
                  const updatedFiles = typeof network?.state?.data?.files === "object"
                    ? { ...network.state.data.files }
                    : {};
                  for (const file of files) {
                    await sbox.files.write(file.path, file.content);
                    updatedFiles[file.path] = file.content;
                  }
                  if (network && typeof network.state === "object" && typeof network.state.data === "object") {
                    network.state.data.files = updatedFiles;
                  }
                  return updatedFiles;
                } catch (e) {
                  return {};
                }
              });
              return newFiles;
            },
          }),
          createTool({
            name: "readFiles",
            description: "Read files from the sandbox",
            parameters: z.object({ files: z.array(z.string()) }),
            handler: async ({ files }, context) => {
              const { step } = context;
              if (!step || typeof step.run !== "function") {
                return "Error: No step context for reading files";
              }
              return await step.run("readFiles", async () => {
                try {
                  const sbox = await getSandbox(sandboxId);
                  const arr: { path: string; content: string }[] = [];
                  for (const path of files) {
                    const content = await sbox.files.read(path);
                    arr.push({ path, content });
                  }
                  return JSON.stringify(arr);
                } catch (e) {
                  return `Error: ${String(e)}`;
                }
              });
            }
          }),
        ],
        lifecycle: {
          onResponse: async ({ result, network }) => {
            const lastText = lastAssistantTextMessageContent(result);
            if (lastText && network && typeof lastText === "string") {
              if (lastText.includes("<task_summary>")) network.state.data.summary = lastText;
            }
            return result;
          },
        },
      });

      const network = createNetwork<AgentState>({
        name: "coding-agent-network",
        agents: [codeAgent],
        maxIter: 15,
        defaultState: state,
        router: async ({ network }) => {
          const summary = network?.state.data?.summary;
          if (!summary) return codeAgent;
          return;
        },
      });

      // -- Main Run: Only pass { state }
      const userPrompt = event.data?.value ?? "Generate a simple app";
      const runMessages = normalizeToMessages(userPrompt);

      console.log("⚙️ [Network.run] Starting agent execution...");
      let result: any;
      
      try {
        // 🔍 Deep diagnostics before running
        console.log("🧠 [Debug] Checking network before run...");
        console.log("   typeof network:", typeof network);
        console.log("   network is defined:", !!network);
        console.log("   network keys:", Object.keys(network ?? {}));
        console.log("   network.agents:", Array.isArray((network as any)?.agents) ? (network as any).agents.map((a: any) => a?.name) : "❌ agents not array");
        console.log("   typeof network.run:", typeof (network as any)?.run);
      
        const firstAgent = (network as any)?.agents?.[0];
        console.log("   firstAgent exists:", !!firstAgent);
        console.log("   firstAgent.name:", firstAgent?.name);
        console.log("   model exists:", !!firstAgent?.model);
        console.log("   typeof firstAgent.model:", typeof firstAgent?.model);
        console.log("   model keys:", Object.keys(firstAgent?.model ?? {}));
        console.log("   typeof model.run:", typeof firstAgent?.model?.run);
        console.log("   typeof model.request:", typeof (firstAgent?.model as any)?.request);
      
        const modelObj = firstAgent?.model;
        if (!modelObj || typeof modelObj.run !== "function") {
          console.warn("⚠️ [Debug Warning] model.run missing or not a function — OpenRouter client setup might be invalid.");
        }
      
        // 🚀 Run the network
        console.log("🚀 [Network.run] Invoking network.run...");
        result = await (network as any).run(runMessages as any, { state });
        console.log("✅ [Network.run] Completed successfully");
      
      } catch (err: any) {
        console.error("❌ [Network.run] Failed:", err);
      
        await prisma.message.create({
          data: {
            projectId: event.data?.projectId ?? "unknown",
            content: `Agent execution failed: ${String(err?.message ?? err)}`,
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      
        throw err;
      }
      

      // -- Generators
      const summaryInput = result?.state?.data?.summary ?? "";

      const fragmentTitleGenerator = createAgent({
        name: "fragment-title-generator",
        system: FRAGMENT_TITLE_PROMPT,
        model: {
          run: async (input: any) => modelRunner(input, "gpt-4o"),
        } as any,
      });

      const responseGenerator = createAgent({
        name: "response-generator",
        system: RESPONSE_PROMPT,
        model: {
          run: async (input: any) => modelRunner(input, "gpt-4o"),
        } as any,
      });

      const { output: fragOut } = await fragmentTitleGenerator.run(summaryInput);
      const { output: respOut } = await responseGenerator.run(summaryInput);

      const fragmentTitle = getTextFromMessage(fragOut?.[0]) || "Fragment";
      const responseText = getTextFromMessage(respOut?.[0]) || "Here you go";

      const sandboxUrl = await step.run("get-sandbox-url", async () => {
        const s = await getSandbox(sandboxId);
        return `https://${s.getHost(3000)}`;
      });

      const isError =
        !result?.state?.data?.summary ||
        Object.keys(result?.state?.data?.files ?? {}).length === 0;

      await step.run("save-result", async () => {
        if (isError) {
          return prisma.message.create({
            data: {
              projectId: event.data.projectId,
              content: "Something went wrong. Please try again.",
              role: "ASSISTANT",
              type: "ERROR",
            },
          });
        }
        return prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: responseText,
            role: "ASSISTANT",
            type: "RESULT",
            fragment: {
              create: {
                sandboxUrl,
                title: fragmentTitle,
                files: result.state.data.files,
              },
            },
          },
        });
      });

      return {
        url: sandboxUrl,
        title: fragmentTitle,
        files: result.state.data.files,
        summary: result.state.data.summary,
      };
    } catch (err: any) {
      await prisma.message.create({
        data: {
          projectId: event.data?.projectId ?? "unknown",
          content: `Fatal error: ${String(err?.message ?? err)}`,
          role: "ASSISTANT",
          type: "ERROR",
        },
      });
      return { error: String(err?.message ?? err) };
    }
  }
);
