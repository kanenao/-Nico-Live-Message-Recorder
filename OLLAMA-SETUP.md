# Ollama AI article generation

This application can use a local Ollama server. No OpenAI API key is needed and article prompts are sent to the local machine's Ollama endpoint.

## Windows setup

1. Install Ollama from https://ollama.com/download
2. Open PowerShell or Command Prompt.
3. Run:

```powershell
ollama pull qwen2.5:3b
```

4. Keep Ollama running. Its default API address is `http://127.0.0.1:11434`.
5. Open the application's settings and test the Ollama connection.

## Privacy and fallback

- The default model is `qwen2.5:3b`.
- No API key or cloud AI account is required.
- If Ollama is unavailable or the selected model is missing, the application uses its existing non-AI article generation path.
- AI output is based only on recorded stream metadata and comments. It must not be treated as a verified transcript of the stream's audio/video.

## Hardware

The model is stored locally and uses the PC's RAM/CPU or supported GPU. Performance depends on available memory and hardware.
