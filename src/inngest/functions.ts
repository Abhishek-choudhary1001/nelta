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
import { safeModelRun } from "@/lib/safemodelrunner";

// =============== 🔧 Utility Functions ===============

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
  if (input && input.messages && Array.isArray(input.messages))
    return normalizeToMessages(input.messages);
  return [{ role: "user", content: String(input ?? "") }];
}



// =============== ⚙️ Inngest Setup ===============

export const inngest = new Inngest({ id: "my-app" });

interface AgentState {
  summary: string;
  files: Record<string, string>;
}

// =============== 🧠 Main Code Agent Function ===============

export const codeAgentFunction = inngest.createFunction(
  { id: "my-app-code-agent" },
  { event: "code-agent/run" },

  async ({ event, step }) => {
    console.log("🚀 [START] codeAgentFunction triggered:", JSON.stringify(event.data ?? {}, null, 2));

    try {
      if (!event.data?.projectId) {
        console.error("❌ [ERROR] Missing projectId in event.data:", event.data);
        throw new Error("Missing projectId in event.data");
      }

      // Sandbox setup
      console.log("🧱 [Sandbox] Creating sandbox...");
      const sandboxId = await step.run("create-sandbox", async () => {
        const s = await Sandbox.create("nlhz8vlwyupq845jsdg9");
        await s.setTimeout(SANDBOX_TIMEOUT);
        console.log("✅ [Sandbox] Created:", s.sandboxId);
        return s.sandboxId;
      });

      // Load chat history
      console.log("💬 [DB] Fetching previous messages...");
      const previousMessages = await step.run("get-prev-msgs", async () => {
        const msgs = await prisma.message.findMany({
          where: { projectId: event.data.projectId },
          orderBy: { createdAt: "asc" },
          take: 5,
        });
        console.log("📜 [DB] Retrieved messages:", msgs.length);
        return msgs.map((m) => ({
          role: m.role === "ASSISTANT" ? "assistant" : "user",
          content: m.content ?? "",
        })) as InngestMessage[];
      });

      // Initial state
      const state = createState<AgentState>(
        { summary: "", files: {} },
        { messages: previousMessages as any }
      );

      // =============== 🧩 Model Runner ===============
      async function modelRunner(input: any, modelName = process.env.LLM_MODEL ?? "qwen/qwen3-coder:free") {
        console.log("🧠 [ModelRunner] Input:", input);
        console.log("🧠 [ModelRunner] Model Name:", modelName);
        try {
          const client = openrouter({ model: modelName });
          console.log("✅ [ModelRunner] OpenRouter Client initialized:", Object.keys(client || {}));
          const messages = normalizeToMessages(input);
          console.log("🗨️ [ModelRunner] Normalized messages:", messages);
          // Use client's request and expect a string or structured response
          const content = await client.request(messages);
          console.log("💬 [ModelRunner] Model response (truncated):", String(content)?.slice?.(0, 300) ?? content);
          // Normalize to the { output: [...] } shape
          const normalized = Array.isArray(content) ? content : [{ role: "assistant", content: String(content) }];
          return { output: normalized };
        } catch (err: any) {
          console.error("❌ [ModelRunner Error]:", err);
          return { output: [{ role: "assistant", content: `Model error: ${String(err?.message ?? err)}` }] };
        }
      }

      // =============== 🧠 Agent Setup ===============
      console.log("⚙️ [Agent] Creating codeAgent...");
      const codeAgent = createAgent<AgentState>({
        name: "code-agent",
        description: "An expert coding agent",
        system: PROMPT,
        model: {
          name: "openrouter-qwen",
          // We provide both run and request wrappers (they use the same underlying modelRunner)
          run: async (input: any) => modelRunner(input, "qwen/qwen3-coder:free"),
          request: async (input: any) => modelRunner(input, "qwen/qwen3-coder:free"),
        } as any,
        tools: [
          createTool({
            name: "terminal",
            description: "Run terminal commands in sandbox",
            parameters: z.object({ command: z.string() }),
            handler: async ({ command }, context) => {
              console.log("💻 [Tool:Terminal] Command received:", command);
              const { step } = context;
              if (!step?.run) return "No step context";
              return await step.run("terminal", async () => {
                const sbox = await getSandbox(sandboxId);
                const result = await sbox.commands.run(command);
                console.log("📤 [Tool:Terminal] Output:", result.stdout);
                return result.stdout;
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
              console.log("📂 [Tool:Files] Writing files:", files.map(f => f.path));
              const { network } = context;
              const sbox = await getSandbox(sandboxId);
              const updated: Record<string, string> = {};
              for (const file of files) {
                await sbox.files.write(file.path, file.content);
                updated[file.path] = file.content;
              }
              if (network?.state?.data?.files) {
                network.state.data.files = { ...network.state.data.files, ...updated };
              }
              console.log("✅ [Tool:Files] Updated:", Object.keys(updated));
              return updated;
            },
          }),
        ],
        lifecycle: {
          onResponse: async ({ result, network }) => {
            const text = lastAssistantTextMessageContent(result);
            console.log("💭 [Lifecycle] onResponse triggered, text:", text?.slice(0, 100));
            if (text?.includes("<task_summary>") && network) {
              network.state.data.summary = text;
              console.log("✅ [Lifecycle] Summary updated.");
            }
            return result;
          },
        },
      });

      // =============== 🌐 Network Setup ===============
      console.log("⚙️ [Network] Creating agent network...");
      const network = createNetwork<AgentState>({
        name: "coding-agent-network",
        agents: [codeAgent],
        maxIter: 15,
        defaultState: state,
        router: async ({ network }) => {
          console.log("🧭 [Router] Invoked, state:", network?.state?.data);
          const summary = network?.state?.data?.summary;
          const agentArray = Array.from(network?.agents?.values?.() ?? []);
          console.log("🧭 [Router] Found agents:", agentArray.length);
          const firstAgent = agentArray[0];
          console.log("🧭 [Router] Returning agent:", summary ? firstAgent?.name : codeAgent.name);
          return summary ? firstAgent ?? codeAgent : codeAgent;
        },
      });

      console.log("✅ [Network] Created:", Object.keys(network ?? {}));
      console.log("🔍 [Network] Agent count:", network?.agents?.size ?? 0);

      // Validate agents
      const agentsList = Array.from(network?.agents?.values?.() ?? []);
      const firstAgent = agentsList?.[0];
      console.log("👤 [Debug] First agent:", firstAgent?.name ?? "none");

      const userPrompt = event.data?.value ?? "Generate a simple app";
      const runMessages = normalizeToMessages(userPrompt);
      console.log("💬 [Run] User prompt:", userPrompt);

      // =============== 🚀 Execution ===============
      let result: any;
      try {
        console.log("🚦 [Debug] Preparing to execute network...");
        console.log("   typeof network:", typeof network);
        console.log("   network keys:", Object.keys(network || {}));
        console.log("   network.agents:", network?.agents);
        console.log("   network._agents (raw):", (network as any)?._agents);
        console.log("   network.defaultModel:", (network as any)?.defaultModel);
        console.log("   typeof network.run:", typeof (network as any)?.run);

        // 🧩 Inspect agents in the network
        const agentsArray = Array.from(((network as any)?._agents?.values?.() ?? []) as Iterable<any>);
        console.log("   agentsArray length:", agentsArray.length);

        if (agentsArray.length > 0) {
          const firstAgent: any = agentsArray[0];
          console.log("   firstAgent (raw):", firstAgent);
          console.log("   firstAgent.name:", (firstAgent as any)?.name);
          console.log("   typeof firstAgent.model:", typeof (firstAgent as any)?.model);
          console.log("   model keys:", Object.keys(((firstAgent as any)?.model) || {}));
          console.log("   typeof model.run:", typeof (firstAgent as any)?.model?.run);
          console.log("   typeof model.request:", typeof (firstAgent as any)?.model?.request);
        } else {
          console.warn("⚠️ [Warning] No agents found in network._agents");
        }

        console.log("   runMessages:", runMessages);
        console.log("   state:", state);

        // 🚀 Execute network.run wrapped in step.run for proper context
        console.log("🏁 [Network.run] Executing network...");
        result = await step.run("execute-network", async () => {
          return await network.run(runMessages, { state, step, event });
        });

        console.log("✅ [Network.run] Completed successfully:", !!result);
      } catch (err: any) {
        console.error("💥 [ERROR] network.run failed:", err);

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

      // =============== 📦 Postprocessing ===============
      const summaryInput = result?.state?.data?.summary ?? "";
      console.log("📝 [Summary] Generated:", summaryInput?.slice?.(0, 150));

      const fragmentTitleGenerator = createAgent({
        name: "fragment-title-generator",
        system: FRAGMENT_TITLE_PROMPT,
        model: {
          // expose run that returns normalized { output: [...] }
          run: async (input: any, ctx?: any) => {
            return await modelRunner(input, "qwen/qwen3-coder:free");
          },
          request: async (input: any, ctx?: any) => {
            return await modelRunner(input, "qwen/qwen3-coder:free");
          },
        } as any,
      });
      
      const responseGenerator = createAgent({
        name: "response-generator",
        system: RESPONSE_PROMPT,
        model: {
          run: async (input: any, ctx?: any) => {
            return await modelRunner(input, "qwen/qwen3-coder:free");
          },
          request: async (input: any, ctx?: any) => {
            return await modelRunner(input, "qwen/qwen3-coder:free");
          },
        } as any,
      });

      console.log("🧩 [Agents] Generating fragment title and response...");
      // Define a minimal context for safeModelRun
      const ctx = { state: result?.state ?? {}, event };

      const { output: fragOut } = await safeModelRun(fragmentTitleGenerator, summaryInput, ctx);
      const { output: respOut } = await safeModelRun(responseGenerator, summaryInput, ctx);

      const fragmentTitle = getTextFromMessage(fragOut?.[0]) || "Fragment";
      const responseText = getTextFromMessage(respOut?.[0]) || "Here you go";

      const sandboxUrl = await step.run("get-sandbox-url", async () => {
        const s = await getSandbox(sandboxId);
        return `https://${s.getHost(3000)}`;
      });

      const isError =
        !result?.state?.data?.summary ||
        Object.keys(result?.state?.data?.files ?? {}).length === 0;

      console.log("💾 [DB] Saving result, isError:", isError);

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

      console.log("✅ [COMPLETE] Function success");
      const safeState = result?.state?.data ?? { files: {}, summary: "" };

      const payload = {
        url: sandboxUrl,
        title: fragmentTitle,
        files: safeState.files,
        summary: safeState.summary,
      };
      
      return payload;
    } catch (err: any) {
      console.error("💥 [FATAL ERROR]", err);
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