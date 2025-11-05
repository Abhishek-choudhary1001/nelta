import type { Message } from "@inngest/agent-kit";

/**
 * Normalize arbitrary model or agent output into a valid Message[].
 */
function normalizeMessages(output: any): Message[] {
  if (!output) return [];

  const arr = Array.isArray(output) ? output : [output];

  return arr
    .filter(Boolean)
    .map((m: any): Message => {
      const role = m?.role ?? "assistant";
      const content = String(m?.content ?? "");

      return {
        role,
        content,
        type: "text",
      } as unknown as Message;
    });
}

/**
 * safeModelRun
 * 
 * Purpose: Runs a model or agent safely and always returns a normalized Message[] output.
 * Accepts either a model object or an agent object.
 */
export async function safeModelRun(
  modelOrAgent: any,
  input: any,
  ctx?: any
): Promise<{ output: Message[] }> {
  try {
    if (!modelOrAgent) {
      throw new Error("safeModelRun: modelOrAgent is undefined or null");
    }

    let res: any;

    // ✅ Check if this is an agent with a .model property first
    const model = modelOrAgent.model ?? modelOrAgent;

    // Try different execution methods
    if (typeof model.run === "function") {
      res = await model.run(input, ctx);
    } else if (typeof model.request === "function") {
      res = await model.request(input, ctx);
    } else if (typeof model.call === "function") {
      res = await model.call(input, ctx);
    } else if (typeof modelOrAgent.run === "function") {
      // Fallback: try calling run directly on the original object
      res = await modelOrAgent.run(input, ctx);
    } else {
      throw new Error("No valid run/request/call method found on model or agent");
    }

    // Normalize the result
    if (Array.isArray(res?.output)) {
      return { output: normalizeMessages(res.output) };
    }

    if (Array.isArray(res)) {
      return { output: normalizeMessages(res) };
    }

    if (res && res.output) {
      return { output: normalizeMessages(res.output) };
    }

    if (res && (res.role || res.content)) {
      return { output: normalizeMessages([res]) };
    }

    // Fallback: plain text result
    return {
      output: normalizeMessages([
        { role: "assistant", content: JSON.stringify(res ?? "No response") },
      ]),
    };
  } catch (err: any) {
    console.error("❌ [safeModelRun] Error:", err);
    return {
      output: normalizeMessages([
        { role: "assistant", content: `Error: ${String(err?.message ?? err)}` },
      ]),
    };
  }
}