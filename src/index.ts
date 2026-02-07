#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { queryOpenAI } from "./providers/openai.js";
import { queryGemini } from "./providers/gemini.js";
import { loadConfig } from "./config.js";
import { routeRequest, getProvider, escalate } from "./router.js";

const config = loadConfig();

const SecondOpinionSchema = z.object({
  prompt: z.string().describe("The problem or question to get a second opinion on"),
  context: z.string().optional().describe("Additional context like code, errors, or prior attempts"),
});

const ADVISOR_SYSTEM_PROMPT = `You are a helpful AI advisor providing a second opinion. Another AI assistant (Claude) is working on a task and has come to you for help. You should:

- Be concise and direct in your response
- Focus on the specific question or problem presented
- Offer alternative approaches if you see them
- Point out potential issues or edge cases
- If reviewing code, be specific about what could be improved and why
- If asked to verify reasoning, clearly state whether you agree or disagree and why`;

const server = new Server(
  {
    name: "mcp-multi-model-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Call a model by provider
async function callModel(model: string, prompt: string, systemPrompt: string): Promise<string> {
  const provider = getProvider(model);

  if (provider === "openai") {
    if (!config.openai?.apiKey) throw new Error("OpenAI API key not configured.");
    return queryOpenAI(config.openai.apiKey, model, prompt, systemPrompt, undefined, undefined);
  } else {
    if (!config.gemini?.apiKey) throw new Error("Gemini API key not configured.");
    return queryGemini(config.gemini.apiKey, model, prompt, systemPrompt, undefined, undefined);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "get_second_opinion",
      description:
        "Get a second opinion from another AI model. " +
        "Uses an intelligent router (gpt-5-nano) to pick the best provider and model: " +
        "OpenAI GPT (5-nano/5-mini/5.2) for code and text tasks, " +
        "Google Gemini (3-flash/3-pro) for multimodal and reasoning tasks. " +
        "Model size auto-scales with complexity, and escalates if confidence is low. " +
        "Use this when you are stuck, need to verify your reasoning, " +
        "want an alternative perspective, or need advice on a tricky implementation.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Describe the problem, question, or situation you need help with. Be specific about what you're stuck on or what you want verified.",
          },
          context: {
            type: "string",
            description: "Optional additional context such as code snippets, error messages, or prior attempts.",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "list_available_models",
      description:
        "List available providers and models, and explain the routing logic.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_available_models") {
      const providers: any = {};

      if (config.openai?.apiKey) {
        providers.openai = {
          configured: true,
          models: {
            "gpt-5-nano": "Router + pipeline tasks (classify/tag/extract/short summary)",
            "gpt-5-mini": "General-purpose text/code with clear instructions",
            "gpt-5.2": "Complex reasoning, ambiguous requests, high-stakes",
          },
        };
      }

      if (config.gemini?.apiKey) {
        providers.gemini = {
          configured: true,
          models: {
            "gemini-3-flash-preview": "Fast multimodal (PDF/image/audio/video), light tasks",
            "gemini-3-pro-preview": "Deep multimodal reasoning, complex analysis",
          },
        };
      }

      if (Object.keys(providers).length === 0) {
        return {
          content: [{ type: "text", text: "No providers configured. Set OPENAI_API_KEY and/or GEMINI_API_KEY." }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            providers,
            routing: {
              router: "gpt-5-nano classifies each request and picks the best model",
              rules: [
                "1. Multimodal (PDF/image/audio/video) → Gemini Flash or Pro",
                "2. Pipeline tasks (classify/tag/extract/summarize) → gpt-5-nano",
                "3. General text/code → gpt-5-mini",
                "4. Complex/ambiguous/high-stakes → gpt-5.2",
              ],
              escalation: "If router confidence < 0.65: nano→mini→5.2, flash→pro",
            },
          }, null, 2),
        }],
      };
    }

    if (name === "get_second_opinion") {
      const params = SecondOpinionSchema.parse(args);
      const { prompt, context } = params;

      const hasOpenAI = !!config.openai?.apiKey;
      const hasGemini = !!config.gemini?.apiKey;

      if (!hasOpenAI && !hasGemini) {
        throw new Error("No API keys configured. Set OPENAI_API_KEY and/or GEMINI_API_KEY.");
      }

      // Need OpenAI for the router
      if (!hasOpenAI) {
        throw new Error("OpenAI API key required for the router (gpt-5-nano). Set OPENAI_API_KEY.");
      }

      // Step 1: Route the request using gpt-5-nano
      const decision = await routeRequest(
        config.openai!.apiKey,
        prompt,
        context,
        hasOpenAI,
        hasGemini
      );

      // Step 2: Build the full prompt
      const fullPrompt = context
        ? `${prompt}\n\nAdditional context:\n${context}`
        : prompt;

      // Step 3: Call the selected model
      let model = decision.selected_model;
      let response: string;

      try {
        response = await callModel(model, fullPrompt, ADVISOR_SYSTEM_PROMPT);
      } catch (error) {
        // Step 4: On failure, escalate and retry
        const escalated = escalate(model);
        try {
          response = await callModel(escalated, fullPrompt, ADVISOR_SYSTEM_PROMPT);
          model = escalated;
          decision.reason += ` (escalated from ${decision.selected_model}: ${error instanceof Error ? error.message : "error"})`;
        } catch (retryError) {
          throw new Error(
            `Both ${model} and ${escalated} failed. ` +
            `Original: ${error instanceof Error ? error.message : "error"}. ` +
            `Retry: ${retryError instanceof Error ? retryError.message : "error"}`
          );
        }
      }

      // Step 5: Return response with routing metadata as separate content blocks
      // First block: routing info (structured for the user to see)
      // Second block: the actual response
      const routing = [
        `--- Routing ---`,
        `Provider: ${getProvider(model)}`,
        `Model:    ${model}`,
        `Task:     ${decision.signals.task_type}`,
        `Stakes:   ${decision.signals.stakes}`,
        `Ambiguity:${decision.signals.ambiguity}`,
        `Confidence:${decision.confidence}`,
        `Reason:   ${decision.reason}`,
        `--- Response ---`,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: routing,
          },
          {
            type: "text",
            text: response,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Multi-Model Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
