import { readFileSync } from "fs";
import { resolve } from "path";

export interface ModelConfig {
  openai?: {
    apiKey: string;
    baseUrl?: string;
  };
  gemini?: {
    apiKey: string;
  };
}

export function loadConfig(): ModelConfig {
  const config: ModelConfig = {};

  // Try to load from config file first
  try {
    const configPath = process.env.MCP_CONFIG_PATH || resolve(process.cwd(), "config.json");
    const configFile = readFileSync(configPath, "utf-8");
    const fileConfig = JSON.parse(configFile);

    if (fileConfig.openai) {
      config.openai = fileConfig.openai;
    }
  } catch (error) {
    // Config file is optional, will fall back to environment variables
  }

  // Environment variables override config file
  if (process.env.OPENAI_API_KEY) {
    config.openai = {
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
    };
  }

  if (process.env.GEMINI_API_KEY) {
    config.gemini = {
      apiKey: process.env.GEMINI_API_KEY,
    };
  }

  return config;
}
