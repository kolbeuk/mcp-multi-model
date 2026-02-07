import { GoogleGenerativeAI } from "@google/generative-ai";

export async function queryGemini(
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt?: string,
  temperature?: number,
  maxTokens?: number
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model });

  const generationConfig: any = {
    temperature: temperature ?? 0.7,
  };

  if (maxTokens) {
    generationConfig.maxOutputTokens = maxTokens;
  }

  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\n${prompt}`
    : prompt;

  const result = await geminiModel.generateContent({
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    generationConfig,
  });

  return result.response.text();
}
