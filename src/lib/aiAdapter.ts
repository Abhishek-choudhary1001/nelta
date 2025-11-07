// src/lib/aiAdapter.ts
import { openai } from "@inngest/agent-kit";

export const aiAdapter = openai({
  baseUrl: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || "qwen/qwen3-coder:free",
});
