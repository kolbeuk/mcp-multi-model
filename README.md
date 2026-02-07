# MCP Multi-Model Server

An MCP server that gives Claude a `get_second_opinion` tool — it automatically queries OpenAI or Google Gemini when Claude needs help, is stuck, or wants to verify its reasoning.

## How It Works

One tool, smart routing:
- **Code queries** → OpenAI (gpt-5-nano / gpt-5-mini / gpt-5.2)
- **Reasoning queries** → Gemini (gemini-3-flash-preview / gemini-3-pro-preview)
- **Model size** scales with query complexity (simple → nano/flash, complex → full)

## Setup on a New Machine

```bash
# 1. Clone the repo
git clone git@github.com:<your-username>/mcp-multi-model.git
cd mcp-multi-model

# 2. Install and build
npm install

# 3. Add to Claude Desktop config
#    macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
#    Windows: %APPDATA%\Claude\claude_desktop_config.json
```

Add this to your Claude Desktop config (create the file if it doesn't exist):

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

```bash
# 4. Restart Claude Desktop
```

That's it. Claude will now have the `get_second_opinion` tool available.

## Verify It Works

In Claude Desktop, ask:
> "Use the get_second_opinion tool to ask: what is 2+2?"

You should see it route to gpt-5-nano and get a response.

## API Keys

You need at least one key. Both is recommended for smart routing.

- **OpenAI:** https://platform.openai.com/api-keys
- **Gemini:** https://aistudio.google.com/apikey

## License

MIT
