import OpenAI from "openai";

export async function queryOpenAI(
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt?: string,
  temperature?: number,
  maxTokens?: number
): Promise<string> {
  const client = new OpenAI({ apiKey });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    messages.push({
      role: "system",
      content: systemPrompt,
    });
  }

  messages.push({
    role: "user",
    content: prompt,
  });

  const params: any = { model, messages };
  if (temperature !== undefined) params.temperature = temperature;
  if (maxTokens !== undefined) params.max_tokens = maxTokens;

  const response = await client.chat.completions.create(params);

  return response.choices[0]?.message?.content || "No response generated";
}
