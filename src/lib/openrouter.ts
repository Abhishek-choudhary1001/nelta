import OpenAI from "openai";

export function openrouter({ model }: { model: string }) {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY!,
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  });

  return {
    // The `request` function that your network will call internally
    async request(messages: any[]) {
      const response = await client.chat.completions.create({
        model,
        messages,
      });

      return response.choices?.[0]?.message?.content ?? "";
    },

    // Optional `run` wrapper for agent-kit compatibility
    async run(input: any) {
      const messages = Array.isArray(input)
        ? input
        : [{ role: "user", content: String(input) }];

      const content = await this.request(messages);
      return [{ role: "assistant", content }];
    },
  };
}
