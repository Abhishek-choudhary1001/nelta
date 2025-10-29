// ✅ src/lib/openrouter.ts — simpler version that supports `network.chat({ messages })`
export function openrouter({ model = "qwen/qwen3-coder:free" } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY in environment");

  return {
    async chat({ messages, temperature = 0.7 }: { messages: { role: string; content: string }[]; temperature?: number }) {
      console.log("🌐 [OpenRouter] Sending chat completion →", model);
      console.log("🧠 [OpenRouter] Messages:", JSON.stringify(messages, null, 2));

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("❌ [OpenRouter] HTTP Error:", res.status, text);
        throw new Error(`OpenRouter API error ${res.status}: ${text}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? "No response";

      console.log("✅ [OpenRouter] Response received (length:", content.length, ")");
      return content;
    },
  };
}
