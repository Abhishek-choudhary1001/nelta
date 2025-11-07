// src/lib/qwenAdapter.ts
import { openai } from "@inngest/agent-kit";

export function createOpenRouterModel(modelId: string) {
  return openai({
    model: modelId, // e.g., "qwen/qwen3-coder:free"
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  });
}
