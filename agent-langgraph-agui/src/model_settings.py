"""Request-scoped model configuration; never changes process credentials."""
import os
import re


def capabilities():
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    fallback = {"anthropic": "claude-sonnet-4-5", "google": "gemini-2.5-flash", "google_genai": "gemini-2.5-flash"}.get(provider, "gpt-4o-mini")
    model = (os.environ.get("BOT_MODEL") or fallback).strip()
    # Only advertise effort on the configured reasoning model. Custom model ids
    # can still be entered; provider validation is authoritative for those ids.
    reasoning = provider == "openai" and re.match(r"^(?:openai:)?(?:gpt-[56]|o[134])", model)
    efforts = ["low", "medium", "high"] if reasoning else []
    return {"framework": "LangGraph", "defaultModel": model, "customModels": True,
            "models": [{"id": model, "name": model, "efforts": efforts}]}


def parse_settings(value):
    if not isinstance(value, dict) or set(value) - {"model", "effort"}:
        raise ValueError("Invalid model settings")
    model = value.get("model")
    if model is not None and (not isinstance(model, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}", model)):
        raise ValueError("Invalid model identifier")
    if model and ":" in model:
        configured_provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
        configured_provider = {"google": "google_genai"}.get(configured_provider, configured_provider)
        configured_model = (os.environ.get("BOT_MODEL") or "").strip()
        allowed_prefix = configured_model.split(":", 1)[0] if ":" in configured_model else configured_provider
        if model.split(":", 1)[0] != allowed_prefix:
            raise ValueError("Changing provider requires a different agent profile")
    effort = value.get("effort")
    if effort is not None:
        available = capabilities()
        if (model or available["defaultModel"]) != available["defaultModel"] or effort not in available["models"][0]["efforts"]:
            raise ValueError("This model does not expose that reasoning effort")
    return {key: val for key, val in value.items() if val is not None}
