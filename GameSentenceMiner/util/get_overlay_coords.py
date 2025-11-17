import asyncio
import io
import base64
import json
import math
import os
import threading
import time
from PIL import Image
from typing import Dict, Any, List, Tuple
import json
from rapidfuzz import fuzz

# Local application imports
from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness
from GameSentenceMiner.util.configuration import OverlayEngine, get_config, get_overlay_config, get_temporary_directory, is_windows, is_beangate, logger
from GameSentenceMiner.util.electron_config import get_ocr_language
from GameSentenceMiner.obs import get_screenshot_PIL
from GameSentenceMiner.web.texthooking_page import send_word_coordinates_to_overlay
from GameSentenceMiner.web.gsm_websocket import overlay_server_thread

# def align_and_correct(ocr_json, reference_text):
#     logger.info(f"Starting align_and_correct with reference_text: '{reference_text}'")
#     corrected = []
#     ref_chars = list(reference_text)
#     logger.info(f"Reference chars: {ref_chars}")

#     for block_idx, block in enumerate(ocr_json):
#         logger.info(f"Processing block {block_idx}: {block}")
#         ocr_chars = [w["text"] for w in block["words"]]
#         ocr_str = "".join(ocr_chars)

#         # Compute edit operations from OCR → Reference
#         ops = Levenshtein.editops(ocr_str, "".join(ref_chars))

#         corrected_words = block["words"][:]

#         # Apply corrections
#         for op_idx, (op, i, j) in enumerate(ops):
#             logger.info(f"Operation {op_idx}: {op}, i={i}, j={j}")
#             if op == "replace":
#                 logger.info(f"Replacing word at index {i} ('{corrected_words[i]['text']}') with reference char '{ref_chars[j]}'")
#                 corrected_words[i]["text"] = ref_chars[j]
#             elif op == "insert":
#                 if i > 0:
#                     prev = corrected_words[i - 1]["bounding_rect"]
#                     bbox = prev  # simple: copy neighbor bbox
#                 else:
#                     bbox = corrected_words[0]["bounding_rect"]
#                 corrected_words.insert(i, {
#                     "text": ref_chars[j],
#                     "bounding_rect": bbox,
#                     "confidence": 1.0
#                 })
#             elif op == "delete":
#                 logger.info(f"Deleting word at index {i} ('{corrected_words[i]['text']}')")
#                 corrected_words[i]["text"] = ""  # mark empty

#         corrected_words = [w for w in corrected_words if w["text"]]

#         block["words"] = corrected_words
#         block["text"] = "".join(w["text"] for w in corrected_words)
#         corrected.append(block)

#     return corrected

# Conditionally import OCR engines
try:
    if os.path.exists(os.path.expanduser('~/.config/oneocr/oneocr.dll')):
        from GameSentenceMiner.owocr.owocr.ocr import OneOCR
    else:
        OneOCR = None
    from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, get_regex
except ImportError as import_err:
    GoogleLens, OneOCR, get_regex = None, None, None
except Exception as e:
    GoogleLens, OneOCR, get_regex = None, None, None
    logger.error(f"Error importing OCR engines: {e}", exc_info=True)

# Conditionally import screenshot library
try:
    import mss
except ImportError:
    mss = None
    
overlay_processor = None
    
class OverlayThread(threading.Thread):
    """
    A thread to run the overlay processing loop.
    This is a simple wrapper around asyncio to run the overlay processing
    in a separate thread.
    """
    def __init__(self):
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self.daemon = True
        self.first_time_run = True

    def run(self):
        """Runs the overlay processing loop."""
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.overlay_loop())

    async def overlay_loop(self):
        """Main loop to periodically process and send overlay data."""
        while True:
            if overlay_server_thread.has_clients():
                if get_config().overlay.periodic:
                    await overlay_processor.find_box_and_send_to_overlay('', True)
                    await asyncio.sleep(get_config().overlay.periodic_interval)
                elif self.first_time_run:
                    await overlay_processor.find_box_and_send_to_overlay('', False)
                    self.first_time_run = False
                else:
                    await asyncio.sleep(3)
            else:
                self.first_time_run = True
                await asyncio.sleep(3)

class OverlayProcessor:
    """
    Handles the entire overlay process from screen capture to text extraction.

    This class encapsulates the logic for taking screenshots, identifying text
    regions, performing OCR, and processing the results into a structured format
    with pixel coordinates.
    """

    def __init__(self):
        """Initializes the OCR engines and configuration."""
        self.config = get_config()
        self.oneocr = None
        self.lens = None
        self.regex = None
        self.ready = False
        self.last_oneocr_result = None
        self.last_lens_result = None
        self.current_task = None  # Track current running task
        self.windows_warning_shown = False

        try:
            if self.config.overlay.websocket_port and all([GoogleLens, get_regex]):
                logger.info("Initializing OCR engines...")
                self.ocr_language = get_ocr_language()
                self.regex = get_regex(self.ocr_language)
                logger.info("OCR engines initialized.")
                self.ready = True
            else:
                logger.warning("OCR dependencies not found or websocket port not configured. OCR functionality will be disabled.")
            
            if is_windows:
                set_dpi_awareness()
                
            if not mss:
                logger.warning("MSS library not found. Screenshot functionality may be limited.")
        except Exception as e:
            logger.error(f"Error initializing OCR engines for overlay, try installing owocr in OCR tab of GSM: {e}", exc_info=True)
            self.oneocr = None
            self.lens = None
            self.regex = None
            
    async def find_box_and_send_to_overlay(self, sentence_to_check: str = None, check_against_last: bool = False):
        """
        Sends the detected text boxes to the overlay via WebSocket.
        Cancels any running OCR task before starting a new one.
        """
        # Cancel any existing task
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                logger.info("Previous OCR task was cancelled")
        if OneOCR and not self.oneocr:
            self.oneocr = OneOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        if GoogleLens and not self.lens:
            self.lens = GoogleLens(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        # Start new task
        self.current_task = asyncio.create_task(self.find_box_for_sentence(sentence_to_check, check_against_last))
        try:
            await self.current_task
        except asyncio.CancelledError:
            logger.info("OCR task was cancelled")
        # logger.info(f"Sending {len(boxes)} boxes to overlay.")
        # await send_word_coordinates_to_overlay(boxes)

    async def find_box_for_sentence(self, sentence_to_check: str = None, check_against_last: bool = False) -> List[Dict[str, Any]]:
        """
        Public method to perform OCR and find text boxes for a given sentence.
        
        This is a wrapper around the main work-horse method, providing
        error handling.
        """
        try:
            return await self._do_work(sentence_to_check, check_against_last=check_against_last)
        except Exception as e:
            logger.error(f"Error during OCR processing: {e}", exc_info=True)
            return []
        
    @staticmethod
    def get_monitor_workarea(monitor_index=0):
        """
        Return MSS-style dict for monitor area.
        For primary monitor, excludes taskbar. For others, returns full monitor area.
        monitor_index: 0 = primary monitor, 1+ = others (as in mss.monitors).
        """
        # set_dpi_awareness()
        with mss.mss() as sct:
            monitors = sct.monitors[1:]
            monitor = monitors[monitor_index] if 0 <= monitor_index < len(monitors) else monitors[0]
            # Return monitor but the Y is 1 less to avoid taskbar on Windows
            return {
                "left": monitor["left"],
                "top": monitor["top"],
                "width": monitor["width"],
                "height": monitor["height"] - 1
            }
            # # return monitors[monitor_index] if 0 <= monitor_index < len(monitors) else monitors[0]
            # if is_windows() and monitor_index == 0:
            #     from ctypes import wintypes
            #     import ctypes
            #     # Get work area for primary monitor (ignores taskbar)
            #     SPI_GETWORKAREA = 0x0030
            #     rect = wintypes.RECT()
            #     res = ctypes.windll.user32.SystemParametersInfoW(
            #         SPI_GETWORKAREA, 0, ctypes.byref(rect), 0
            #     )
            #     if not res:
            #         raise ctypes.WinError()
                
            #     return {
            #         "left": rect.left,
            #         "top": rect.top,
            #         "width": rect.right - rect.left,
            #         "height": rect.bottom - rect.top,
            #     }
            # elif is_windows() and monitor_index > 0:
            #     # Secondary monitors: just return with a guess of how tall the taskbar is
            #     taskbar_height_guess = 48  # A common taskbar height, may vary
            #     mon = monitors[monitor_index]
            #     return {
            #         "left": mon["left"],
            #         "top": mon["top"],
            #         "width": mon["width"],
            #         "height": mon["height"] - taskbar_height_guess
            #     }
            # else:
            #     # For non-Windows systems or unspecified monitors, return the monitor area as-is
            #     return monitors[monitor_index] if 0 <= monitor_index < len(monitors) else monitors[0]


    def _get_full_screenshot(self) -> Tuple[Image.Image | None, int, int]:
        """Captures a screenshot of the configured monitor."""
        # Prefer MSS (X11) when available, but fall back to OBS/other methods on Wayland
        wayland = os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland' or bool(os.environ.get('WAYLAND_DISPLAY'))

        if mss and not wayland:
            try:
                with mss.mss() as sct:
                    monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)  # Get primary monitor work area
                    sct_img = sct.grab(monitor)
                    img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
                    img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                    return img, monitor['width'], monitor['height']
            except Exception as e:
                # MSS (X11) failed (commonly XGetImage on Wayland or permission issues). Fall back below.
                logger.debug(f"MSS screenshot failed: {e}")

        # Fallback: try OBS-based screenshot (if OBS is connected and has a suitable source)
        try:
            logger.debug("Attempting fallback screenshot via OBS sources")
            obs_img = get_screenshot_PIL(compression=100, img_format='jpg', width=None, height=None)
            if obs_img is not None:
                # get_screenshot_PIL returns a PIL Image already
                # Try to infer monitor size from the image
                w, h = obs_img.size
                obs_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                return obs_img.convert('RGBA'), w, h
        except Exception as e:
            logger.debug(f"OBS fallback screenshot failed: {e}")

        # As a last resort, raise an informative error
        raise RuntimeError("Failed to capture screen: MSS unavailable or failed and OBS fallback unavailable. On Wayland you must run with a portal or use an OBS source.")

    def _create_composite_image(
        self, 
        full_screenshot: Image.Image,
        crop_coords_list: List[Tuple[int, int, int, int]],
        monitor_width: int,
        monitor_height: int
    ) -> Image.Image:
        """
        Creates a new image by pasting cropped text regions onto a transparent background.
        This isolates text for more accurate secondary OCR.
        """
        if not crop_coords_list:
            return full_screenshot

        # Create a transparent canvas
        composite_img = Image.new("RGBA", (monitor_width, monitor_height), (0, 0, 0, 0))

        for crop_coords in crop_coords_list:
            # Ensure crop coordinates are within image bounds
            x1, y1, x2, y2 = crop_coords
            x1 = max(0, min(x1, full_screenshot.width))
            y1 = max(0, min(y1, full_screenshot.height))
            x2 = max(x1, min(x2, full_screenshot.width))
            y2 = max(y1, min(y2, full_screenshot.height))
            
            # Skip if the coordinates result in an invalid box
            if x1 >= x2 or y1 >= y2:
                continue
            try:
                cropped_image = full_screenshot.crop((x1, y1, x2, y2))
            except ValueError:
                logger.warning("Error cropping image, using original image")
                return full_screenshot
            # Paste the cropped image onto the canvas at its original location
            paste_x = math.floor(x1)
            paste_y = math.floor(y1)
            composite_img.paste(cropped_image, (paste_x, paste_y))
            
        composite_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_trimmed.png"))
        
        return composite_img

    async def _do_work(self, sentence_to_check: str = None, check_against_last: bool = False) -> Tuple[List[Dict[str, Any]], int]:
        """The main OCR workflow with cancellation support."""
        if not self.lens:
            logger.error("OCR engines are not initialized. Cannot perform OCR for Overlay.")
            return []
        
        if not is_windows:
            if self.windows_warning_shown is False:
                logger.warning("Overlay OCR is only fully supported on Windows currently. This may change in future versions.")
            self.windows_warning_shown = True
            return []
        
        if get_config().overlay.scan_delay > 0:
            try:
                await asyncio.sleep(get_config().overlay.scan_delay)
            except asyncio.CancelledError:
                logger.info("OCR task cancelled during scan delay")
                raise

        # Check for cancellation before taking screenshot
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()

        # 1. Get screenshot
        full_screenshot, monitor_width, monitor_height = self._get_full_screenshot()
        if not full_screenshot:
            logger.warning("Failed to get a screenshot.")
            return []
            
        # Check for cancellation after screenshot
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        if self.oneocr:
            tries = get_overlay_config().number_of_local_scans_per_event if not check_against_last else 1
            for i in range(tries):
                if i > 0:
                    try:
                        await asyncio.sleep(0.1)
                    except asyncio.CancelledError:
                        logger.info("OCR task cancelled during local scan delay")
                        raise
                # 2. Use OneOCR to find general text areas (fast)
                res, text, oneocr_results, crop_coords_list = self.oneocr(
                    full_screenshot,
                    return_coords=True,
                    multiple_crop_coords=True,
                    return_one_box=False,
                    furigana_filter_sensitivity=get_overlay_config().minimum_character_size,
                )
                
                if not crop_coords_list:
                    return        
                
                # Check for cancellation after OneOCR
                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()
                
                text_str = "".join([text for text in text if self.regex.match(text)])
                
                # RapidFuzz fuzzy match 90% to not send the same results repeatedly
                if self.last_oneocr_result and check_against_last:
                    
                    score = fuzz.ratio(text_str, self.last_oneocr_result)
                    if score >= get_config().overlay.periodic_ratio * 100:
                        return
                self.last_oneocr_result = text_str
                
                await send_word_coordinates_to_overlay(self._convert_oneocr_results_to_percentages(oneocr_results, monitor_width, monitor_height))
                
                # If User Home is beangate
                if is_beangate:
                    with open("oneocr_results.json", "w", encoding="utf-8") as f:
                        f.write(json.dumps(oneocr_results, ensure_ascii=False, indent=2))
                
                if get_config().overlay.engine == OverlayEngine.ONEOCR.value and self.oneocr:
                    logger.info("Sent %d text boxes to overlay.", len(oneocr_results))
                    return

                # Check for cancellation before creating composite image
                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()

                # 3. Create a composite image with only the detected text regions
                composite_image = self._create_composite_image(
                    full_screenshot, 
                    crop_coords_list, 
                    monitor_width, 
                    monitor_height
                )
        else:
            composite_image = full_screenshot
        
        # Check for cancellation before Google Lens processing
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # 4. Use Google Lens on the cleaner composite image for higher accuracy
        res = self.lens(
            composite_image,
            return_coords=True,
            furigana_filter_sensitivity=get_overlay_config().minimum_character_size
        )
        
        # Check for cancellation after Google Lens
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        if len(res) != 3:
            return
        
        success, text_list, coords = res
        
        text_str = "".join([text for text in text_list if self.regex.match(text)])
        
        # RapidFuzz fuzzy match 90% to not send the same results repeatedly
        if self.last_lens_result and check_against_last:
            score = fuzz.ratio(text_str, self.last_lens_result)
            if score >= get_config().overlay.periodic_ratio * 100:
                logger.info("Google Lens results are similar to the last results (score: %d). Skipping overlay update.", score)
                return
        self.last_lens_result = text_str

        if not success or not coords:
            return
        
        # Check for cancellation before final processing
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # 5. Process the high-accuracy results into the desired format
        extracted_data = self._extract_text_with_pixel_boxes(
            api_response=coords,
            original_width=monitor_width,
            original_height=monitor_height,
            crop_x=0,
            crop_y=0,
            crop_width=composite_image.width,
            crop_height=composite_image.height,
            use_percentages=True
        )
        await send_word_coordinates_to_overlay(extracted_data)
        
        logger.info("Sent %d text boxes to overlay.", len(extracted_data))

    def _extract_text_with_pixel_boxes(
        self,
        api_response: Dict[str, Any],
        original_width: int,
        original_height: int,
        crop_x: int,
        crop_y: int,
        crop_width: int,
        crop_height: int,
        use_percentages: bool
    ) -> List[Dict[str, Any]]:
        """
        Parses Google Lens API response and converts normalized coordinates
        to absolute pixel coordinates.
        """
        results = []
        try:
            paragraphs = api_response["objects_response"]["text"]["text_layout"]["paragraphs"]
        except (KeyError, TypeError):
            return []  # Return empty if the expected structure isn't present

        for para in paragraphs:
            for line in para.get("lines", []):
                # if not self.regex.match(line.get("plain_text", "")):
                #     continue
                line_text_parts = []
                word_list = []

                for word in line.get("words", []):
                    if self.ocr_language not in ['ja', 'zh', 'ko', 'th', 'lo', 'km', 'my', 'bo']:
                        word["plain_text"] += word["text_separator"]
                    word_text = word.get("plain_text", "")
                    line_text_parts.append(word_text)
                    
                    word_box = self._convert_box_to_overlay_coords(
                        word["geometry"]["bounding_box"],
                        crop_x, crop_y, crop_width, crop_height,
                        use_percentage=use_percentages
                    )
                    
                    word_list.append({
                        "text": word_text,
                        "bounding_rect": word_box
                    })
                
                if not line_text_parts:
                    continue
                
                full_line_text = "".join(line_text_parts)
                line_box = self._convert_box_to_overlay_coords(
                    line["geometry"]["bounding_box"],
                    crop_x, crop_y, crop_width, crop_height, use_percentage=use_percentages
                )

                results.append({
                    "text": full_line_text,
                    "bounding_rect": line_box,
                    "words": word_list
                })
        return results

    def _convert_box_to_overlay_coords(
        self,
        bbox_data: Dict[str, float],
        crop_x: int,
        crop_y: int,
        crop_width: int,
        crop_height: int,
        use_percentage: bool
    ) -> Dict[str, float]:
        """
        Simplified conversion: scales normalized bbox to pixel coordinates within
        the cropped region, then offsets by the crop position. Ignores rotation.
        If use_percentage is True, returns coordinates as percentages of the crop dimensions.
        """
        cx, cy = bbox_data['center_x'], bbox_data['center_y']
        w, h = bbox_data['width'], bbox_data['height']

        if use_percentage:
            # Return coordinates as percentages of the crop dimensions
            box_width = w
            box_height = h
            center_x = cx
            center_y = cy
        else:
            # Scale normalized coordinates to pixel coordinates relative to the crop area
            box_width = w * crop_width
            box_height = h * crop_height

            # Calculate center within the cropped area and then add the crop offset
            center_x = (cx * crop_width) + crop_x
            center_y = (cy * crop_height) + crop_y

        # Calculate corners (unrotated)
        half_w, half_h = box_width / 2, box_height / 2
        return {
            "x1": center_x - half_w, "y1": center_y - half_h,
            "x2": center_x + half_w, "y2": center_y - half_h,
            "x3": center_x + half_w, "y3": center_y + half_h,
            "x4": center_x - half_w, "y4": center_y + half_h,
        }
        
    def _convert_oneocr_results_to_percentages(
        self,
        oneocr_results: List[Dict[str, Any]],
        monitor_width: int,
        monitor_height: int
    ) -> List[Dict[str, Any]]:
        """
        Converts OneOCR results with pixel coordinates to percentages relative to the monitor size.
        """
        converted_results = []
        for item in oneocr_results:
            # Check Regex
            # if not self.regex.match(item.get("text", "")):
            #     continue
            bbox = item.get("bounding_rect", {})
            if not bbox:
                continue
            # Convert each coordinate to a percentage of the monitor dimensions
            converted_bbox = {
                key: (value / monitor_width if "x" in key else value / monitor_height)
                for key, value in bbox.items()
            }
            converted_item = item.copy()
            converted_item["bounding_rect"] = converted_bbox
            converted_results.append(converted_item)
            for word in converted_item.get("words", []):
                word_bbox = word.get("bounding_rect", {})
                # If not CJK or Southeast Asian script, add a space after each word
                if self.ocr_language not in ['ja', 'zh', 'ko', 'th', 'lo', 'km', 'my', 'bo']:
                    word["text"] += " "
                if word_bbox:
                    word["bounding_rect"] = {
                        key: (value / monitor_width if "x" in key else value / monitor_height)
                        for key, value in word_bbox.items()
                    }
        # logger.info(f"Converted OneOCR results to percentages: {converted_results}")
        return converted_results
    
async def init_overlay_processor():
    """
    Initializes the overlay processor and starts the overlay thread.
    This function can be called at application startup.
    """
    global overlay_processor
    overlay_processor = OverlayProcessor()
    overlay_thread = OverlayThread()
    overlay_thread.start()
    logger.info("Overlay processor initialized and thread started.")
    
    
def get_overlay_processor() -> OverlayProcessor:
    """
    Returns the initialized overlay processor instance.
    """
    global overlay_processor
    if overlay_processor is None:
        asyncio.run(init_overlay_processor())
    return overlay_processor

async def main_test_screenshot():
    """
    A test function to demonstrate screenshot and image composition.
    This is preserved from your original __main__ block.
    """
    processor = OverlayProcessor()
    
    # Use the class method to get the screenshot
    img, monitor_width, monitor_height = processor._get_full_screenshot()
    if not img:
        logger.error("Could not get screenshot for test.")
        return
        
    img.show()
    
    # Create a transparent image with the same size as the monitor
    new_img = Image.new("RGBA", (monitor_width, monitor_height), (0, 0, 0, 0))
    
    # Calculate coordinates to center the captured image (if it's not full-screen)
    left = (monitor_width - img.width) // 2
    top = (monitor_height - img.height) // 2
    
    print(f"Image size: {img.size}, Monitor size: {monitor_width}x{monitor_height}")
    print(f"Pasting at: Left={left}, Top={top}")
    
    new_img.paste(img, (left, top))
    new_img.show()
    
async def main_run_ocr():
    """
    Main function to demonstrate running the full OCR process.
    """
    overlay_processor = OverlayProcessor()
    while True:
        await overlay_processor.find_box_and_send_to_overlay('', False)
        await asyncio.sleep(10)


if __name__ == '__main__':
    try:
        # To run the screenshot test:
        # asyncio.run(main_test_screenshot())
        
        # To run the full OCR process:
        asyncio.run(main_run_ocr())

    except KeyboardInterrupt:
        logger.info("Script terminated by user.")
    except Exception as e:
        logger.error(f"An error occurred in the main execution block: {e}", exc_info=True)