"""
Handler for processing messages from the overlay websocket connection.
"""
import asyncio
import json
from typing import Optional

from GameSentenceMiner.ai.ai_prompting import get_ai_prompt_result
from GameSentenceMiner.obs import get_current_game
from GameSentenceMiner.util.config.configuration import logger, get_config
from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags
from GameSentenceMiner.util.overlay.get_overlay_coords import get_overlay_processor
from GameSentenceMiner.util.text_log import get_all_lines
from GameSentenceMiner.web.gsm_websocket import websocket_manager, ID_OVERLAY


class OverlayRequestHandler:
    """Handles requests from the overlay, such as translation requests."""
    
    def __init__(self):
        self.processing = False
    
    async def handle_message(self, message_str: str):
        """
        Process incoming messages from the overlay websocket.
        
        Args:
            message_str: JSON string containing the request
        """
        try:
            message = json.loads(message_str)
            message_type = message.get('type')
            
            logger.info(f"Received overlay message of type: {message_type}")
            
            if message_type == 'translate-request':
                await self.handle_translation_request()
            elif message_type == 'restore-focus-request':
                await self.handle_restore_focus_request(message)
            elif message_type == 'send-key-request':
                await self.handle_send_key_request(message)
            elif message_type == 'process-pause-request':
                await self.handle_process_pause_request(message)
            else:
                logger.warning(f"Unknown overlay message type: {message_type}")
                
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse overlay message: {e}")
        except Exception as e:
            logger.exception(f"Error handling overlay message: {e}")
    
    async def handle_translation_request(self):
        """
        Handle a translation request from the overlay.
        Translates the last flattened OCR result from the overlay processor.
        """
        if self.processing:
            logger.display("Translation already in progress, skipping request")
            return
        
        try:
            self.processing = True
            
            # Check if AI is enabled
            if not get_config().ai.is_configured():
                await self.send_error("AI translation is not enabled in GSM settings")
                return
            
            # Get the overlay processor instance
            overlay_processor = get_overlay_processor()
            
            # Get the last OCR result text
            last_oneocr_result = overlay_processor.last_oneocr_result
            last_lens_result = overlay_processor.last_lens_result
            
            # Use whichever result is available (prefer oneocr, then lens)
            sentence = last_oneocr_result or last_lens_result
            
            if not sentence or not sentence.strip():
                await self.send_error("No OCR text available to translate")
                return
            
            logger.display(f"Translating: {sentence}")
            
            # Get current game for context
            game_title = get_current_game(sanitize=False, update=False) or "Unknown Game"
            
            # Get text log lines for context (but don't use them as the source)
            lines = get_all_lines()
            
            # Create a minimal line object for the translation
            # The sentence parameter is what actually gets translated
            last_line = None
            if lines:
                last_line = lines[-1]
            
            # Perform translation using AI
            # Run in executor to avoid blocking the event loop
            loop = asyncio.get_event_loop()
            translation = await loop.run_in_executor(
                None,
                get_ai_prompt_result,
                lines,
                sentence,  # This is the actual text to translate
                last_line,
                game_title,
                False,
                None
            )
            
            translation = remove_html_and_cloze_tags(translation)
            
            if translation and translation.strip():
                logger.display(f"Translation: {translation}")
                await self.send_translation(translation)
            else:
                await self.send_error("Translation returned empty result")
                
        except Exception as e:
            logger.exception(f"Translation request failed: {e}")
            await self.send_error(f"Translation failed: {str(e)}")
        finally:
            self.processing = False
    
    async def handle_restore_focus_request(self, message: Optional[dict] = None):
        """
        Handle a focus restoration request from the overlay.
        Attempts to restore focus to the target game window.
        """
        try:
            delay_ms = 0
            if isinstance(message, dict):
                try:
                    delay_ms = int(message.get("delay", 0) or 0)
                except (TypeError, ValueError):
                    delay_ms = 0
            delay_ms = max(0, min(delay_ms, 5000))
            if delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000.0)

            overlay_processor = get_overlay_processor()
            
            # Check if we have a window monitor with a target window
            if overlay_processor.window_monitor and overlay_processor.window_monitor.target_hwnd:
                await overlay_processor.window_monitor.activate_target_window()
            else:
                logger.debug("No target window to restore focus to")
                
        except Exception as e:
            logger.exception(f"Failed to restore focus to target window: {e}")

    async def handle_send_key_request(self, message: Optional[dict] = None):
        """
        Handle a key-forward request from the overlay.
        Currently supports forwarding Enter to the target game window.
        """
        try:
            payload = message if isinstance(message, dict) else {}
            key_name = str(payload.get("key", "")).strip().lower()
            source = str(payload.get("source", "overlay")).strip().lower() or "overlay"
            activate_window = bool(payload.get("activateWindow", True))
            try:
                target_pid = int(payload.get("targetPid", 0) or 0)
            except (TypeError, ValueError):
                target_pid = 0

            if key_name not in {"enter", "return"}:
                logger.warning(f"Unsupported overlay key request from {source}: {key_name}")
                return

            overlay_processor = get_overlay_processor()
            monitor = overlay_processor.window_monitor if overlay_processor else None
            if not monitor or not monitor.target_hwnd:
                logger.debug(f"No target window available for overlay key request from {source}")
                return

            sent = await monitor.send_enter_to_target_window(
                target_pid=target_pid if target_pid > 0 else None,
                activate_window=activate_window,
            )
            if not sent:
                logger.warning(f"Failed to send Enter key to target window (source={source})")
        except Exception as e:
            logger.exception(f"Failed handling overlay key request: {e}")

    async def handle_process_pause_request(self, message: dict):
        """
        Handle explicit pause/resume requests from overlay hotkeys.
        Uses explicit actions to avoid conflicting toggle behavior.
        """
        action = str(message.get("action", "")).strip().lower()
        source = str(message.get("source", "overlay")).strip().lower() or "overlay"
        if action not in {"pause", "resume"}:
            logger.warning(f"Invalid process pause action from overlay: {action}")
            return

        try:
            from GameSentenceMiner.util.platform.window_state_monitor import request_overlay_process_pause

            result = request_overlay_process_pause(action=action, source=source)
            logger.debug(
                f"Overlay process pause request action={action} source={source} result={result}"
            )
        except Exception as e:
            logger.exception(f"Failed handling process pause request action={action} source={source}: {e}")
    
    async def send_translation(self, translation: str):
        """Send translation result back to overlay."""
        message = {
            'type': 'translation-result',
            'data': translation
        }
        await websocket_manager.send(ID_OVERLAY, message)
    
    async def send_error(self, error_message: str):
        """Send error message back to overlay."""
        message = {
            'type': 'translation-error',
            'error': error_message
        }
        await websocket_manager.send(ID_OVERLAY, message)


# Global instance
overlay_handler = OverlayRequestHandler()
