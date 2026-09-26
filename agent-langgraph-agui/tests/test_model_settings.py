import asyncio
import pytest

from src import main
from src.model_settings import parse_settings
from src.tool_runtime import RunTools, _current


@pytest.mark.asyncio
async def test_concurrent_model_choices_never_change_process_defaults(monkeypatch):
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("BOT_MODEL", "gpt-5")
    monkeypatch.delenv("CHATGPT_AUTH_FILE", raising=False)
    monkeypatch.setattr(main, "init_chat_model", lambda model, **kwargs: (model, kwargs))

    async def resolve(settings):
        token = _current.set(RunTools(model_settings=parse_settings(settings)))
        try:
            await asyncio.sleep(0)
            return main._model()
        finally:
            _current.reset(token)

    low, other = await asyncio.gather(resolve({"effort": "low"}), resolve({"model": "gpt-5-mini"}))
    assert low == ("gpt-5", {"model_provider": "openai", "reasoning": {"effort": "low"}})
    assert other == ("gpt-5-mini", {"model_provider": "openai"})
    assert main._model() == ("gpt-5", {"model_provider": "openai"})


def test_model_override_cannot_supply_credentials_or_change_provider(monkeypatch):
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    for value in [{"api_key": "secret"}, {"model": "anthropic:claude"}, {"effort": "unsupported"}, []]:
        with pytest.raises(ValueError):
            parse_settings(value)
