"""Integration acceptance using the approved synthetic repository WAV fixture."""

import asyncio
from pathlib import Path

from engine import SpeechEngine


def test_offline_model_recognizes_approved_radio_command():
    fixture = Path(__file__).resolve().parents[1] / "fixtures" / "voice" / "full-globe-turn-on-radio.wav"

    async def scenario():
        service = SpeechEngine()
        await service.start()
        try:
            response = await service.transcribe(fixture.read_bytes(), "en")
            assert "full globe" in response["text"].lower()
            assert "turn on the radio" in response["text"].lower()
        finally:
            service.close()

    asyncio.run(scenario())
