"""iMessage channel implementation using bridge WebSocket."""

import asyncio
import json
import mimetypes
import re
from collections import OrderedDict

from loguru import logger

from nanobot.bus.events import OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.base import BaseChannel
from nanobot.config.schema import IMessageConfig


class IMessageChannel(BaseChannel):
    """
    iMessage channel that connects to a bridge over WebSocket.

    Expected bridge protocol is aligned with WhatsApp channel bridge:
    - inbound: {"type":"message","sender":"...","content":"...","id":"...","media":[...]}
    - outbound: {"type":"send","to":"...","text":"..."}
    """

    name = "imessage"
    display_name = "iMessage"

    def __init__(self, config: IMessageConfig, bus: MessageBus):
        super().__init__(config, bus)
        self.config: IMessageConfig = config
        self._ws = None
        self._connected = False
        self._processed_message_ids: OrderedDict[str, None] = OrderedDict()

    async def start(self) -> None:
        """Start the iMessage channel by connecting to the bridge."""
        import websockets

        bridge_url = self.config.bridge_url
        logger.info("Connecting to iMessage bridge at {}...", bridge_url)

        self._running = True

        while self._running:
            try:
                async with websockets.connect(bridge_url) as ws:
                    self._ws = ws
                    if self.config.bridge_token:
                        await ws.send(json.dumps({"type": "auth", "token": self.config.bridge_token}))
                    self._connected = True
                    logger.info("Connected to iMessage bridge")

                    async for message in ws:
                        try:
                            await self._handle_bridge_message(message)
                        except Exception as e:
                            logger.error("Error handling iMessage bridge message: {}", e)

            except asyncio.CancelledError:
                break
            except Exception as e:
                self._connected = False
                self._ws = None
                logger.warning("iMessage bridge connection error: {}", e)

                if self._running:
                    logger.info("Reconnecting in 5 seconds...")
                    await asyncio.sleep(5)

    async def stop(self) -> None:
        """Stop the iMessage channel."""
        self._running = False
        self._connected = False

        if self._ws:
            await self._ws.close()
            self._ws = None

    async def send(self, msg: OutboundMessage) -> None:
        """Send a message through iMessage."""
        # iMessage has no native "stream edit" UX like Telegram topic edits.
        # Skip progress frames to avoid duplicate-looking replies.
        if (msg.metadata or {}).get("_progress"):
            return

        if not self._ws or not self._connected:
            logger.warning("iMessage bridge not connected")
            return

        try:
            text = self._sanitize_outbound_text(msg.content or "")
            payload = {
                "type": "send",
                "to": msg.chat_id,
                "text": text,
            }
            await self._ws.send(json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            logger.error("Error sending iMessage message: {}", e)

    @staticmethod
    def _sanitize_outbound_text(text: str) -> str:
        """
        Remove transport-only tags that should not be visible in iMessage.

        Example:
        [[reply_to:136]] hello  -> hello
        """
        return re.sub(r"^\s*\[\[reply_to:[^\]]+\]\]\s*", "", text).strip()

    async def _handle_bridge_message(self, raw: str) -> None:
        """Handle a message from the bridge."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Invalid JSON from iMessage bridge: {}", raw[:100])
            return

        msg_type = data.get("type")

        if msg_type == "message":
            sender = str(data.get("sender") or data.get("from") or "")
            chat_id = str(data.get("chat_id") or data.get("chat") or sender)
            content = str(data.get("content") or data.get("text") or "")
            message_id = str(data.get("id") or "")

            if message_id:
                if message_id in self._processed_message_ids:
                    return
                self._processed_message_ids[message_id] = None
                while len(self._processed_message_ids) > 1000:
                    self._processed_message_ids.popitem(last=False)

            sender_id = sender.split(":")[-1] if ":" in sender else sender
            media_paths = data.get("media") or []

            if media_paths:
                for p in media_paths:
                    mime, _ = mimetypes.guess_type(p)
                    media_type = "image" if mime and mime.startswith("image/") else "file"
                    media_tag = f"[{media_type}: {p}]"
                    content = f"{content}\n{media_tag}" if content else media_tag

            await self._handle_message(
                sender_id=sender_id,
                chat_id=chat_id,
                content=content,
                media=media_paths,
                metadata={
                    "message_id": message_id,
                    "timestamp": data.get("timestamp"),
                    "is_group": data.get("isGroup", False),
                },
            )

        elif msg_type == "status":
            status = data.get("status")
            logger.info("iMessage status: {}", status)
            if status == "connected":
                self._connected = True
            elif status == "disconnected":
                self._connected = False

        elif msg_type == "error":
            logger.error("iMessage bridge error: {}", data.get("error"))
