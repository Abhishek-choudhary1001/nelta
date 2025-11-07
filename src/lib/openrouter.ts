// src/lib/openrouter.ts
import OpenAI from "openai";

export function openrouter({ model }: { model: string }) {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY!,
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  });

  return {
    // The primary request function
    async request(messages: any[]) {
      try {
        // Normalize messages to OpenAI format
        const formattedMessages = messages.map(m => ({
          role: m.role || "user",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        }));

        console.log("🔵 [OpenRouter] Sending request with messages:", formattedMessages.length);
        
        const response = await client.chat.completions.create({
          model,
          messages: formattedMessages,
        });

        const content = response.choices?.[0]?.message?.content ?? "";
        console.log("✅ [OpenRouter] Response received:", content.slice(0, 200));
        
        return content;
      } catch (error: any) {
        console.error("❌ [OpenRouter] Request failed:", error.message);
        throw new Error(`OpenRouter request failed: ${error.message}`);
      }
    },

    // Compatible with agent-kit's expected format
    async run(input: any) {
      const messages = Array.isArray(input)
        ? input
        : [{ role: "user", content: String(input) }];

      const content = await this.request(messages);
      
      // Return in agent-kit format
      return {
        output: [{ role: "assistant", content, type: "text" }]
      };
    },
  };
}