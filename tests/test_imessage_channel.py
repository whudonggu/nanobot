import json

import pytest

from nanobot.bus.queue import MessageBus
from nanobot.channels.imessage import IMessageChannel
from nanobot.channels.manager import ChannelManager
from nanobot.config.schema import Config, IMessageConfig


def test_channels_config_supports_imessage() -> None:
    config = Config()
    assert hasattr(config.channels, "imessage")
    assert config.channels.imessage.enabled is False


def test_channel_manager_registers_imessage_when_enabled() -> None:
    config = Config()
    config.channels.imessage.enabled = True
    config.channels.imessage.allow_from = ["*"]

    manager = ChannelManager(config, MessageBus())

    assert "imessage" in manager.enabled_channels


@pytest.mark.asyncio
async def test_imessage_channel_forwards_inbound_message() -> None:
    bus = MessageBus()
    channel = IMessageChannel(IMessageConfig(allow_from=["*"]), bus)

    await channel._handle_bridge_message(
        json.dumps(
            {
                "type": "message",
                "sender": "iMessage:+1234567890",
                "chat_id": "+1234567890",
                "content": "hello",
                "id": "msg-1",
            }
        )
    )

    inbound = await bus.consume_inbound()
    assert inbound.channel == "imessage"
    assert inbound.sender_id == "+1234567890"
    assert inbound.chat_id == "+1234567890"
    assert inbound.content == "hello"
