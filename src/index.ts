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

const config = loadConfig();

const SecondOpinionSchema = z.object({
  prompt: z.string().describe("The problem or question to get a second opinion on"),
  context: z.string().optional().describe("Additional context like code, errors, or prior attempts"),
});

// Analyze query complexity and return a score: "simple" | "moderate" | "complex"
function analyzeComplexity(prompt: string, context?: string): "simple" | "moderate" | "complex" {
  const fullText = context ? `${prompt} ${context}` : prompt;
  const wordCount = fullText.split(/\s+/).length;
  const codeBlockCount = (fullText.match(/```/g) || []).length / 2;
  const hasMultipleQuestions = (fullText.match(/\?/g) || []).length > 1;

  const complexKeywords = [
    "architect", "design", "refactor", "debug", "security", "performance",
    "optimize", "tradeoff", "trade-off", "compare", "review", "analyze",
    "complex", "system", "infrastructure", "migration", "strategy",
  ];
  const complexHits = complexKeywords.filter((kw) =>
    fullText.toLowerCase().includes(kw)
  ).length;

  if (wordCount < 50 && codeBlockCount === 0 && complexHits === 0 && !hasMultipleQuestions) {
    return "simple";
  }

  if (wordCount < 200 && codeBlockCount <= 1 && complexHits <= 1) {
    return "moderate";
  }

  return "complex";
}

// Detect if the query is better suited to a specific provider's strengths
function detectQueryType(prompt: string, context?: string): "code" | "reasoning" | "general" {
  const fullText = context ? `${prompt} ${context}` : prompt;
  const lower = fullText.toLowerCase();

  const codeSignals = [
    "code", "function", "class", "bug", "error", "stack trace", "syntax",
    "compile", "runtime", "api", "endpoint", "database", "query", "sql",
    "regex", "algorithm", "data structure", "typescript", "javascript",
    "python", "rust", "go ", "java", "```",
  ];

  const reasoningSignals = [
    "explain", "why", "how does", "what if", "compare", "pros and cons",
    "tradeoff", "trade-off", "should i", "best practice", "approach",
    "architecture", "design pattern", "strategy", "plan",
  ];

  const codeHits = codeSignals.filter((s) => lower.includes(s)).length;
  const reasoningHits = reasoningSignals.filter((s) => lower.includes(s)).length;

  if (codeHits > reasoningHits && codeHits >= 2) return "code";
  if (reasoningHits > codeHits && reasoningHits >= 2) return "reasoning";
  return "general";
}

interface ModelSelection {
  provider: "openai" | "gemini";
  model: string;
  reason: string;
}

// Pick the best provider + model for the query
function selectProviderAndModel(
  prompt: string,
  context?: string,
  hasOpenAI = false,
  hasGemini = false
): ModelSelection {
  const complexity = analyzeComplexity(prompt, context);
  const queryType = detectQueryType(prompt, context);

  // If only one provider is available, use it
  if (hasOpenAI && !hasGemini) {
    const model = complexity === "simple" ? "gpt-5-nano"
      : complexity === "moderate" ? "gpt-5-mini"
      : "gpt-5.2";
    return { provider: "openai", model, reason: `${complexity} query, OpenAI only` };
  }

  if (hasGemini && !hasOpenAI) {
    const model = complexity === "complex" ? "gemini-3-pro-preview" : "gemini-3-flash-preview";
    return { provider: "gemini", model, reason: `${complexity} query, Gemini only` };
  }

  // Both available — route based on query type + complexity

  // Code-heavy queries -> OpenAI (GPT excels at code)
  if (queryType === "code") {
    const model = complexity === "simple" ? "gpt-5-nano"
      : complexity === "moderate" ? "gpt-5-mini"
      : "gpt-5.2";
    return { provider: "openai", model, reason: `${complexity} code query -> OpenAI` };
  }

  // Reasoning/analysis queries -> Gemini (strong at reasoning, large context)
  if (queryType === "reasoning") {
    const model = complexity === "complex" ? "gemini-3-pro-preview" : "gemini-3-flash-preview";
    return { provider: "gemini", model, reason: `${complexity} reasoning query -> Gemini` };
  }

  // General queries — use complexity to decide
  // Simple/moderate general -> cheapest option (nano/flash)
  if (complexity === "simple") {
    return { provider: "openai", model: "gpt-5-nano", reason: "simple general query -> nano" };
  }

  if (complexity === "moderate") {
    return { provider: "gemini", model: "gemini-3-flash-preview", reason: "moderate general query -> Gemini Flash" };
  }

  // Complex general -> full power GPT
  return { provider: "openai", model: "gpt-5.2", reason: "complex general query -> GPT 5.2" };
}

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "get_second_opinion",
      description:
        "Get a second opinion from another AI model. " +
        "Automatically picks the best provider (OpenAI GPT or Google Gemini) and model size " +
        "based on query complexity and type. Code-heavy queries route to GPT, " +
        "reasoning/analysis queries route to Gemini, and model size scales with complexity. " +
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
        "List available providers and models for second opinions.",
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
          models: ["gpt-5.2", "gpt-5-mini", "gpt-5-nano"],
          routing: "Code-heavy queries, simple general queries",
        };
      }

      if (config.gemini?.apiKey) {
        providers.gemini = {
          configured: true,
          models: ["gemini-3-pro-preview", "gemini-3-flash-preview"],
          routing: "Reasoning/analysis queries, moderate general queries",
        };
      }

      if (Object.keys(providers).length === 0) {
        return {
          content: [{
            type: "text",
            text: "No providers configured. Set OPENAI_API_KEY and/or GEMINI_API_KEY.",
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            providers,
            routing: "Provider and model are auto-selected based on query type (code vs reasoning) and complexity (simple/moderate/complex).",
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

      const selection = selectProviderAndModel(prompt, context, hasOpenAI, hasGemini);

      const fullPrompt = context
        ? `${prompt}\n\nAdditional context:\n${context}`
        : prompt;

      let response: string;

      if (selection.provider === "openai") {
        response = await queryOpenAI(
          config.openai!.apiKey,
          selection.model,
          fullPrompt,
          ADVISOR_SYSTEM_PROMPT,
          undefined,
          undefined
        );
      } else {
        response = await queryGemini(
          config.gemini!.apiKey,
          selection.model,
          fullPrompt,
          ADVISOR_SYSTEM_PROMPT,
          undefined,
          undefined
        );
      }

      return {
        content: [{
          type: "text",
          text: `[Provider: ${selection.provider} | Model: ${selection.model} | Reason: ${selection.reason}]\n\n${response}`,
        }],
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
