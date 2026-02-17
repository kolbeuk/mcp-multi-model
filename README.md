# MCP Multi-Model Server

An MCP server that gives Claude a `get_second_opinion` tool — it automatically queries OpenAI or Google Gemini when Claude needs help, is stuck, or wants to verify its reasoning.

## How It Works

One tool, smart routing:
- **Code queries** → OpenAI (gpt-5-nano / gpt-5-mini / gpt-5.2)
- **Reasoning queries** → Gemini (gemini-3-flash-preview / gemini-3-pro-preview)
- **Model size** scales with query complexity (simple → nano/flash, complex → full)

### Architecture

```
Claude Desktop
  └─ calls get_second_opinion(prompt, context?)
       └─ MCP Server receives the request
            ├─ Step 1: Router (gpt-5-nano) analyzes the prompt
            │    └─ Returns: model choice, confidence score, task signals
            ├─ Step 2: Calls the selected model with the full prompt
            ├─ Step 3: If confidence < 0.65, auto-escalates to a bigger model
            └─ Step 4: Returns the response + routing metadata to Claude
```

### Routing Logic

The router (powered by gpt-5-nano) classifies every request and picks the best model based on these rules:

| Scenario | Model Selected |
|---|---|
| Multimodal input (images, PDFs, audio, video) | `gemini-3-flash-preview` |
| Complex multimodal + high stakes | `gemini-3-pro-preview` |
| Pipeline tasks (classify, tag, extract, summarize) | `gpt-5-nano` |
| General text or code with clear instructions | `gpt-5-mini` |
| Complex reasoning, ambiguous, or high-stakes | `gpt-5.2` |

### Escalation

If something goes wrong or confidence is low, the server automatically escalates:

- `gpt-5-nano` → `gpt-5-mini` → `gpt-5.2`
- `gemini-3-flash-preview` → `gemini-3-pro-preview`

This happens in two cases:
1. **Low confidence**: Router confidence score is below 0.65
2. **Model failure**: The selected model errors out, so the next tier is tried

### Available Tools

| Tool | Description |
|---|---|
| `get_second_opinion` | Ask another AI model for help. Provide a prompt and optional context (code, errors, etc). |
| `list_available_models` | See which providers and models are configured, plus the routing rules. |

## Project Structure

```
src/
├── index.ts              # MCP server setup, tool definitions, request handling
├── config.ts             # Loads API keys from env vars or config.json
├── router.ts             # Intelligent routing: model selection, escalation, fallbacks
└── providers/
    ├── openai.ts          # OpenAI API wrapper (GPT models)
    └── gemini.ts          # Google Gemini API wrapper
```

## Setup on a New Machine

```bash
# 1. Clone the repo
git clone git@github.com:<your-username>/mcp-multi-model.git
cd mcp-multi-model

# 2. Install and build
npm install
```

### Add to Claude Desktop

Edit your Claude Desktop config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add this block (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "multi-model": {
      "command": "node",
      "args": ["/full/path/to/mcp-multi-model/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "your-openai-key",
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

**Important:** Replace `/full/path/to/` with the actual path where you cloned the repo.

Then restart Claude Desktop.

### Add to Claude Code (CLI)

Add this to your `.claude/settings.json` or project-level `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "multi-model": {
      "command": "node",
      "args": ["/full/path/to/mcp-multi-model/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "your-openai-key",
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

## Configuration

API keys can be provided two ways (env vars take priority):

1. **Environment variables** (recommended): `OPENAI_API_KEY` and `GEMINI_API_KEY` — set in the MCP config as shown above
2. **Config file**: Create a `config.json` in the project root:
   ```json
   {
     "openai": { "apiKey": "sk-..." },
     "gemini": { "apiKey": "AI..." }
   }
   ```

You need **at least OpenAI** configured (the router uses gpt-5-nano). Both providers is recommended for full smart routing.

## Verify It Works

In Claude Desktop or Claude Code, ask:
> "Use the get_second_opinion tool to ask: what is 2+2?"

You should see it route to gpt-5-nano and get a response, along with routing metadata showing the model choice, confidence, and reasoning.

## API Keys

- **OpenAI:** https://platform.openai.com/api-keys
- **Gemini:** https://aistudio.google.com/apikey

## License

MIT
