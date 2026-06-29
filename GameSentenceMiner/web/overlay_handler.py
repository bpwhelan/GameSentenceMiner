"""
Handler for processing messages from the overlay websocket connection.
"""

import asyncio
import json
from typing import Optional

from GameSentenceMiner.ai.ai_prompting import get_ai_prompt_result
from GameSentenceMiner.obs import get_current_game, get_current_scene
from GameSentenceMiner.util.config.configuration import (
    coerce_gsm_owned_overlay_value,
    get_config,
    get_master_config,
    logger,
    save_full_config,
    serialize_gsm_owned_overlay,
)
from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags
from GameSentenceMiner.util.overlay.get_overlay_coords import get_overlay_processor
from GameSentenceMiner.util.text_log import TextSource, game_log, get_all_lines, normalize_text_for_comparison
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
            message_type = message.get("type")

            logger.info(f"Received overlay message of type: {message_type}")

            if message_type == "translate-request":
                await self.handle_translation_request()
            elif message_type == "manual-overlay-scan-request":
                await self.handle_manual_overlay_scan_request(message)
            elif message_type == "manual-mode-background-request":
                await self.handle_manual_mode_background_request(message)
            elif message_type == "restore-focus-request":
                await self.handle_restore_focus_request(message)
            elif message_type == "send-key-request":
                await self.handle_send_key_request(message)
            elif message_type == "send-click-request":
                await self.handle_send_click_request(message)
            elif message_type == "process-pause-request":
                await self.handle_process_pause_request(message)
            elif message_type == "set-gsm-overlay-config":
                await self.handle_gsm_overlay_config_request(message)
            elif message_type == "get-gsm-overlay-config":
                await self.broadcast_gsm_owned_overlay_config()
            elif message_type == "select-ocr-area":
                self.handle_select_ocr_area_request(message)
            elif message_type == "open-gsm-settings":
                self.handle_open_gsm_settings_request(message)
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
                None,
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

    async def handle_manual_overlay_scan_request(self, message: Optional[dict] = None):
        """
        Handle a manual overlay scan request from the overlay.
        This mirrors the Python manual overlay scan hotkey behavior.
        """
        try:
            payload = message if isinstance(message, dict) else {}
            source = str(payload.get("source", "overlay")).strip().lower() or "overlay"

            overlay_processor = get_overlay_processor()
            loop = getattr(overlay_processor, "processing_loop", None)
            if not loop or not loop.is_running():
                logger.warning(f"Overlay loop not ready yet; ignoring manual overlay scan request (source={source}).")
                return

            logger.info(f"Manually triggering overlay scan via overlay request (source={source}).")
            future = asyncio.run_coroutine_threadsafe(
                overlay_processor.find_box_and_send_to_overlay(source=TextSource.HOTKEY),
                loop,
            )

            # Mirror hotkey behavior: schedule on overlay loop and return immediately.
            def _log_scan_error(done_future):
                try:
                    done_future.result()
                except Exception as scan_error:
                    logger.exception(f"Manual overlay scan request failed: {scan_error}")

            future.add_done_callback(_log_scan_error)
        except Exception as e:
            logger.exception(f"Failed handling manual overlay scan request: {e}")

    async def handle_manual_mode_background_request(self, message: Optional[dict] = None):
        """
        Capture and send a desktop snapshot for the manual-mode overlay background.

        Sent by the overlay app the moment manual mode activates, *before* it focuses the
        overlay, so the grab happens while the game still owns the screen.
        """
        try:
            overlay_processor = get_overlay_processor()
            loop = getattr(overlay_processor, "processing_loop", None)
            if not loop or not loop.is_running():
                logger.warning("Overlay loop not ready yet; ignoring manual-mode background request.")
                return
            asyncio.run_coroutine_threadsafe(
                overlay_processor.capture_and_send_manual_background(),
                loop,
            )
        except Exception as e:
            logger.exception(f"Failed handling manual-mode background request: {e}")

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
            monitor = overlay_processor.window_monitor
            if not monitor:
                logger.debug("No window monitor available to restore focus.")
                return

            # The cached hwnd can be cleared after the game was minimized — try to re-resolve,
            # but activate_target_window also falls back to the last-known hwnd on its own.
            if not monitor.target_hwnd:
                try:
                    monitor.target_hwnd = monitor.find_target_hwnd()
                except Exception as e:
                    logger.debug(f"find_target_hwnd during focus restore failed: {e}")

            activated = await monitor.activate_target_window()
            if not activated:
                logger.warning(
                    f"Focus restore failed (target_hwnd={monitor.target_hwnd}, "
                    f"last_known={monitor.last_known_target_hwnd})."
                )

        except Exception as e:
            logger.exception(f"Failed to restore focus to target window: {e}")

    # Curated keys the overlay is allowed to forward to the target game window.
    ALLOWED_FORWARD_KEYS = {"enter", "return", "space", "ctrl", "control", "escape", "esc", "tab"}

    async def handle_send_key_request(self, message: Optional[dict] = None):
        """
        Handle a key-forward request from the overlay.
        Supports forwarding a curated set of keys (see ALLOWED_FORWARD_KEYS) to the
        target game window. The overlay never forwards arbitrary user-typed keys.
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

            if key_name not in self.ALLOWED_FORWARD_KEYS:
                logger.warning(f"Unsupported overlay key request from {source}: {key_name}")
                return

            overlay_processor = get_overlay_processor()
            monitor = overlay_processor.window_monitor if overlay_processor else None
            if not monitor or not monitor.target_hwnd:
                logger.debug(f"No target window available for overlay key request from {source}")
                return

            sent = await monitor.send_key_to_target_window(
                key_name,
                target_pid=target_pid if target_pid > 0 else None,
                activate_window=activate_window,
            )
            if not sent:
                logger.warning(f"Failed to send '{key_name}' key to target window (source={source})")
        except Exception as e:
            logger.exception(f"Failed handling overlay key request: {e}")

    async def handle_send_click_request(self, message: Optional[dict] = None):
        """
        Handle a left-click-forward request from the overlay.
        Clicks the center of the target game window's client area.
        """
        try:
            payload = message if isinstance(message, dict) else {}
            source = str(payload.get("source", "overlay")).strip().lower() or "overlay"
            activate_window = bool(payload.get("activateWindow", True))
            try:
                target_pid = int(payload.get("targetPid", 0) or 0)
            except (TypeError, ValueError):
                target_pid = 0

            overlay_processor = get_overlay_processor()
            monitor = overlay_processor.window_monitor if overlay_processor else None
            if not monitor or not monitor.target_hwnd:
                logger.debug(f"No target window available for overlay click request from {source}")
                return

            sent = await monitor.send_click_to_target_window(
                target_pid=target_pid if target_pid > 0 else None,
                activate_window=activate_window,
            )
            if not sent:
                logger.warning(f"Failed to send click to target window (source={source})")
        except Exception as e:
            logger.exception(f"Failed handling overlay click request: {e}")

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
            from GameSentenceMiner.util.platform.window_state_monitor import (
                request_overlay_process_pause,
            )

            result = request_overlay_process_pause(action=action, source=source)
            logger.debug(f"Overlay process pause request action={action} source={source} result={result}")
        except Exception as e:
            logger.exception(f"Failed handling process pause request action={action} source={source}: {e}")

    @staticmethod
    def _extract_overlay_config_updates(message: dict) -> dict:
        """Read inbound overlay-config updates as {python_field: raw_value} from either shape."""
        settings = message.get("settings")
        if isinstance(settings, dict):
            return dict(settings)
        key = str(message.get("key", "")).strip()
        if key:
            return {key: message.get("value")}
        return {}

    async def handle_gsm_overlay_config_request(self, message: dict):
        """
        Persist GSM-owned overlay settings changed from the Electron overlay UI.
        Accepts a single {key, value} or a batch {settings: {field: value}}.
        """
        updates = self._extract_overlay_config_updates(message)
        if not updates:
            return

        master_config = get_master_config()
        if master_config is None:
            logger.warning("Unable to save overlay config from overlay: master config is not loaded.")
            return

        current_config = master_config.get_config()
        applied = {}
        for field_name, raw_value in updates.items():
            try:
                value = coerce_gsm_owned_overlay_value(field_name, raw_value)
            except KeyError:
                logger.warning(f"Ignoring unsupported GSM overlay config key from overlay: {field_name}")
                continue
            except (TypeError, ValueError) as e:
                logger.warning(f"Ignoring invalid GSM overlay config value for {field_name}: {e}")
                continue
            setattr(current_config.overlay, field_name, value)
            applied[field_name] = value

        if not applied:
            return

        master_config.overlay = current_config.overlay
        save_full_config(master_config)

        if "check_previous_lines_for_recycled_indicator" in applied:
            self._sync_recycled_line_cache(applied["check_previous_lines_for_recycled_indicator"])
        self._apply_overlay_runtime_side_effects(current_config.overlay, applied)
        logger.info(f"Updated GSM-owned overlay settings from overlay: {sorted(applied)}")

        await self.broadcast_gsm_owned_overlay_config(current_config.overlay)

    def _apply_overlay_runtime_side_effects(self, overlay, applied: dict) -> None:
        """Re-resolve runtime state for fields that need more than a plain config write."""
        if "monitor_to_capture" in applied or "monitor_to_capture_id" in applied:
            try:
                from GameSentenceMiner.util.platform.monitor_selection import (
                    get_mss_monitor_descriptors,
                    set_overlay_monitor_identity_from_index,
                )

                monitors = [descriptor["bounds"] for descriptor in get_mss_monitor_descriptors()]
                set_overlay_monitor_identity_from_index(overlay, monitors, overlay.monitor_to_capture)
            except Exception as e:
                logger.debug(f"Could not re-resolve overlay monitor selection after config change: {e}")

    async def broadcast_gsm_owned_overlay_config(self, overlay=None) -> None:
        """Push the full GSM-owned overlay subset (+ monitor list) to the overlay UI."""
        if overlay is None:
            master_config = get_master_config()
            if master_config is None:
                return
            overlay = master_config.get_config().overlay
        await websocket_manager.send(
            ID_OVERLAY,
            {
                "type": "gsm-overlay-config-updated",
                "settings": serialize_gsm_owned_overlay(overlay),
                "monitors": list(getattr(overlay, "monitors", []) or []),
            },
        )

    def handle_select_ocr_area_request(self, message: dict):
        """Launch the OCR/overlay area selector from the overlay settings UI."""
        try:
            from GameSentenceMiner.util.config.configuration import gsm_state

            settings_window = getattr(gsm_state, "config_app", None)
            if settings_window is None:
                logger.warning("Unable to open OCR area selector from overlay: settings window is not initialized.")
                return
            settings_window.request_open_overlay_area_selector()
        except Exception as e:
            logger.exception(f"Failed to open OCR area selector from overlay: {e}")

    def _sync_recycled_line_cache(self, enabled: bool) -> None:
        if not enabled:
            if game_log.previous_lines:
                game_log.previous_lines = set()
                logger.info("Cleared previous line recycle cache because overlay previous-line checking is disabled.")
            return

        previous_lines = set()
        try:
            from GameSentenceMiner.util.database.db import GameLinesTable

            for line in GameLinesTable.get_all_lines_for_scene(get_current_scene()):
                normalized_line = normalize_text_for_comparison(getattr(line, "line_text", ""))
                if normalized_line:
                    previous_lines.add(normalized_line)
            game_log.previous_lines = previous_lines
            logger.info(f"Loaded {len(previous_lines)} previous lines for game '{get_current_game()}'")
        except Exception as e:
            logger.debug(f"Error getting previous lines for game after overlay config change: {e}")

    def handle_open_gsm_settings_request(self, message: dict):
        """
        Open the main GSM settings window from the overlay settings UI.
        """
        root_tab_key = str(message.get("root_tab_key") or "").strip() or "profiles"
        subtab_key = str(message.get("subtab_key") or "").strip()

        try:
            from GameSentenceMiner.util.config.configuration import gsm_state

            settings_window = getattr(gsm_state, "config_app", None)
            if settings_window is None:
                logger.warning("Unable to open GSM settings from overlay: settings window is not initialized.")
                return

            settings_window.show_window(root_tab_key=root_tab_key, subtab_key=subtab_key)
        except Exception as e:
            logger.exception(f"Failed to open GSM settings from overlay: {e}")

    async def send_translation(self, translation: str):
        """Send translation result back to overlay."""
        message = {"type": "translation-result", "data": translation}
        await websocket_manager.send(ID_OVERLAY, message)

    async def send_error(self, error_message: str):
        """Send error message back to overlay."""
        message = {"type": "translation-error", "error": error_message}
        await websocket_manager.send(ID_OVERLAY, message)


# Global instance
overlay_handler = OverlayRequestHandler()
