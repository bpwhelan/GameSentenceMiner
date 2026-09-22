# Translation and sentence help

Open **Config → AI / Translation → General**, choose a provider, and follow the setup panel.
A manual Translate or Explain request also opens this tab when the selected provider is not configured.
Automatic translation shows guidance without opening settings repeatedly.

1. Open the provider's account/API-key link and sign in or create an account.
2. Create an API key, paste it into GSM, and choose a model.
3. Click **Test connection**. GSM sends one short request using the current form values.
4. After the test succeeds, retry your request in the overlay or text feed. Settings save automatically.

**Add To Anki** is optional; it is not the switch for manual translation or sentence help.
Explanations use the native language selected in General settings. Keys use GSM's existing local configuration storage.

## Providers

| Provider | Account and key | Notes |
| --- | --- | --- |
| Gemini | [Google AI Studio](https://aistudio.google.com/apikey) | Create a key in a project; import or create a project if needed. [Pricing and free-tier availability](https://ai.google.dev/gemini-api/docs/pricing) vary by model and region. |
| Groq | [GroqCloud API keys](https://console.groq.com/keys) | Create a key and select an available text model. Check [rate limits](https://console.groq.com/docs/rate-limits). |
| OpenAI-compatible | Your provider's API console | Supply its API key, model ID, and base URL. API usage is separate from chat subscriptions. |
| Ollama / LM Studio | Local model server | Install and load a model, then enter its server URL and model ID. |
| DeepL | DeepL API account | Translation only. Sentence help requires a language-model provider. |

Existing Z.ai configurations remain editable, but Z.ai is no longer offered for new setup because Flash availability has been unreliable.
Free access is subject to the provider's current limits and availability; GSM does not enable billing or switch to a paid backup automatically.

## Sentence help

- **Text feed:** open **Explain sentence**, choose a task, and click **Explain**. Choose **Ask a question** for a custom question.
- **Overlay:** use the **Explain…** menu in the floating toolbar. The answer appears in a scrollable, selectable panel with Close and AI setup controls.
- Tasks include sentence breakdown, grammar, vocabulary/readings/idioms, nuance and tone, and scene summary.
- Explicit study requests keep their output separate from translations and do not write to the dialogue's translation cache.

## Prompt customization

Under **AI / Translation → Prompts**, select a preset for AI output added to Anki, or keep the existing canned/custom settings.
**Copy selected preset to custom prompt** makes a preset editable. **Preview prompt** renders a sample locally without an API call.

Custom instructions and full templates support `{game_title}`, `{character_context}`, `{dialogue_context}`, `{sentence}`, and `{native_language}`.
Full templates also support `{prompt_to_use}` and must include `{sentence}`. Literal JSON braces need no escaping.
Dedicated overlay block translations retain their JSON contract; explicit Explain requests retain their study instructions.

If a request fails, the UI provides guidance for rejected keys, unavailable models, and quota/rate limits.
After changing a key or model, run Test connection again. Live tests consume the selected provider's normal API allowance.
