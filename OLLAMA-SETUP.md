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

## Optional local audio transcription (Whisper.cpp)

Audio transcription is local and free, but requires a Whisper.cpp Windows executable and a multilingual GGML model.

1. Download a Windows build of whisper.cpp from https://github.com/ggml-org/whisper.cpp/releases
2. Download a multilingual model such as `ggml-base.bin` from https://huggingface.co/ggerganov/whisper.cpp/tree/main
3. In 放送記事, choose `whisper-cli.exe` and the `ggml-base.bin` model.
4. Select a recorded video and generate the article. FFmpeg extracts mono 16 kHz audio; Whisper.cpp transcribes Japanese locally; the transcript, representative video frames, and Nico Live comments are sent to local Ollama for article composition.

If Whisper is not configured or fails, article generation continues with the available video frames and comments. Recognition can be inaccurate with music, overlapping speakers, or noisy audio. Review important quotes against the original stream.

Live article sessions currently analyze captured live frames and comments. Live audio capture/transcription is a separate follow-up because the preview window does not currently expose a reliable audio stream to the article pipeline.
