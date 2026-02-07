import { queryOpenAI } from "./providers/openai.js";

export interface RoutingDecision {
  selected_model: string;
  confidence: number;
  signals: {
    multimodal: boolean;
    stakes: "low" | "medium" | "high";
    ambiguity: "low" | "medium" | "high";
    context_size: "short" | "medium" | "long";
    strict_output: boolean;
    task_type: "classify" | "extract" | "summarize" | "write" | "code" | "plan" | "reason" | "other";
  };
  fallback_model: string;
  reason: string;
}

const ROUTER_SYSTEM_PROMPT = `You are a model router. Return ONLY valid JSON matching the schema.
Choose selected_model from:
["gemini-3-flash-preview","gemini-3-pro-preview","gpt-5-nano","gpt-5-mini","gpt-5.2"].

MODEL ROUTING RULES:

1) Multimodal input (PDF/image/audio/video):
   - Default: gemini-3-flash-preview (fast multimodal)
   - If complex reasoning / high stakes / multi-step: gemini-3-pro-preview

2) High-volume pipeline tasks (classify/tag/extract/short summary), low stakes:
   - gpt-5-nano

3) General-purpose text/code with clear instructions:
   - gpt-5-mini

4) Complex reasoning / ambiguous requests / multi-doc synthesis / high-stakes:
   - gpt-5.2

Schema:
{
  "selected_model": "...",
  "confidence": 0.0-1.0,
  "signals": {
    "multimodal": true/false,
    "stakes": "low"|"medium"|"high",
    "ambiguity": "low"|"medium"|"high",
    "context_size": "short"|"medium"|"long",
    "strict_output": true/false,
    "task_type": "classify"|"extract"|"summarize"|"write"|"code"|"plan"|"reason"|"other"
  },
  "fallback_model": "...",
  "reason": "one short sentence"
}

Return ONLY the JSON object. No markdown, no explanation.`;

const VALID_MODELS = [
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gpt-5-nano",
  "gpt-5-mini",
  "gpt-5.2",
];

export function escalate(model: string): string {
  if (model === "gpt-5-nano") return "gpt-5-mini";
  if (model === "gpt-5-mini") return "gpt-5.2";
  if (model === "gemini-3-flash-preview") return "gemini-3-pro-preview";
  return "gpt-5.2"; // top tier fallback
}

export function getProvider(model: string): "openai" | "gemini" {
  return model.startsWith("gemini") ? "gemini" : "openai";
}

// Detect multimodal signals in the prompt/context
function detectMultimodal(prompt: string, context?: string): boolean {
  const fullText = `${prompt} ${context || ""}`.toLowerCase();
  const signals = [
    "image", "picture", "photo", "screenshot", "diagram",
    "pdf", "document", "attachment",
    "audio", "sound", "recording", "voice",
    "video", "clip", "footage",
    "base64", "data:image", "data:audio",
  ];
  return signals.some((s) => fullText.includes(s));
}

export async function routeRequest(
  apiKey: string,
  prompt: string,
  context?: string,
  hasOpenAI = false,
  hasGemini = false
): Promise<RoutingDecision> {
  const multimodal = detectMultimodal(prompt, context);

  // Hard override: if multimodal and no Gemini, still use OpenAI but note it
  // If multimodal and Gemini available, bias towards Gemini
  const multimodalHint = multimodal
    ? "\nNOTE: The request appears to involve multimodal content (images/PDF/audio/video)."
    : "";

  const availableHint = !hasGemini
    ? "\nCONSTRAINT: Only OpenAI models are available (gpt-5-nano, gpt-5-mini, gpt-5.2)."
    : !hasOpenAI
    ? "\nCONSTRAINT: Only Gemini models are available (gemini-3-flash-preview, gemini-3-pro-preview)."
    : "";

  const routerInput = JSON.stringify({
    userRequest: prompt,
    additionalContext: context || null,
    multimodalDetected: multimodal,
  });

  try {
    const raw = await queryOpenAI(
      apiKey,
      "gpt-5-nano",
      `${routerInput}${multimodalHint}${availableHint}`,
      ROUTER_SYSTEM_PROMPT,
      undefined,
      undefined
    );

    // Parse JSON — strip markdown fences if present
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const decision: RoutingDecision = JSON.parse(cleaned);

    // Validate the selected model
    if (!VALID_MODELS.includes(decision.selected_model)) {
      decision.selected_model = "gpt-5-mini"; // safe default
      decision.confidence = 0.5;
    }

    // Enforce provider availability
    const provider = getProvider(decision.selected_model);
    if (provider === "gemini" && !hasGemini) {
      // Remap to OpenAI equivalent
      decision.selected_model = decision.selected_model === "gemini-3-pro-preview"
        ? "gpt-5.2"
        : "gpt-5-mini";
      decision.reason += " (remapped: Gemini not available)";
    }
    if (provider === "openai" && !hasOpenAI) {
      // Remap to Gemini equivalent
      decision.selected_model = decision.selected_model === "gpt-5.2"
        ? "gemini-3-pro-preview"
        : "gemini-3-flash-preview";
      decision.reason += " (remapped: OpenAI not available)";
    }

    // Confidence-based escalation
    if (decision.confidence < 0.65) {
      decision.selected_model = escalate(decision.selected_model);
      decision.reason += ` (escalated: confidence ${decision.confidence})`;
    }

    // Update fallback
    decision.fallback_model = escalate(decision.selected_model);

    return decision;
  } catch (error) {
    // Router failed — fall back to simple heuristic
    let model: string;
    if (multimodal && hasGemini) {
      model = "gemini-3-flash-preview";
    } else {
      model = "gpt-5-mini"; // safe middle ground
    }

    return {
      selected_model: model,
      confidence: 0.5,
      signals: {
        multimodal,
        stakes: "medium",
        ambiguity: "medium",
        context_size: "medium",
        strict_output: false,
        task_type: "other",
      },
      fallback_model: escalate(model),
      reason: `Router failed, using fallback: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}
