import asyncio
import io
import base64
import math
from PIL import Image
from GameSentenceMiner.util.configuration import get_config
from typing import Dict, Any, List, Tuple

from GameSentenceMiner.util.electron_config import get_ocr_language

if get_config().wip.overlay_websocket_send:
    from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, OneOCR, get_regex
from GameSentenceMiner.obs import *

if get_config().wip.overlay_websocket_send:
    oneocr = OneOCR()
    lens = GoogleLens()


def _convert_box_to_pixels_v2(
    bbox_data: Dict[str, float], 
    original_width: int, 
    original_height: int,
    crop_x: int,
    crop_y: int,
    crop_width: int,
    crop_height: int
) -> Dict[str, float]:
    """
    Simplified conversion: scales normalized bbox to pixel coordinates, ignores rotation.

    Args:
        bbox_data: A dictionary with normalized 'center_x', 'center_y', 'width', 'height'.
        original_width: The width of the original, full-size image in pixels.
        original_height: The height of the original, full-size image in pixels.

    Returns:
        A dictionary of the four corner points with absolute pixel coordinates.
    """
    cx, cy = bbox_data['center_x'], bbox_data['center_y']
    w, h = bbox_data['width'], bbox_data['height']

    # Scale normalized coordinates to pixel coordinates
    box_width_px = w * crop_width
    box_height_px = h * crop_height
    center_x_px = cx * crop_width + crop_x
    center_y_px = cy * crop_height + crop_y

    # Calculate corners (no rotation)
    x1 = center_x_px - box_width_px / 2
    y1 = center_y_px - box_height_px / 2
    x2 = center_x_px + box_width_px / 2
    y2 = center_y_px - box_height_px / 2
    x3 = center_x_px + box_width_px / 2
    y3 = center_y_px + box_height_px / 2
    x4 = center_x_px - box_width_px / 2
    y4 = center_y_px + box_height_px / 2

    return {
        "x1": x1,
        "y1": y1,
        "x2": x2,
        "y2": y2,
        "x3": x3,
        "y3": y3,
        "x4": x4,
        "y4": y4,
    }
    
def _convert_box_to_pixels(
    bbox_data: Dict[str, float], 
    original_width: int, 
    original_height: int,
    crop_x: int,
    crop_y: int,
    crop_width: int,
    crop_height: int
) -> Dict[str, Dict[str, float]]:
    """
    Converts a normalized bounding box to an absolute pixel-based quad.

    Args:
        bbox_data: A dictionary with normalized 'center_x', 'center_y', etc.
        original_width: The width of the original, full-size image in pixels.
        original_height: The height of the original, full-size image in pixels.

    Returns:
        A dictionary of the four corner points with absolute pixel coordinates.
    """
    # Normalized coordinates from the input
    cx, cy = bbox_data['center_x'], bbox_data['center_y']
    w, h = bbox_data['width'], bbox_data['height']
    angle_rad = bbox_data.get('rotation_z', 0.0)

    # Calculate un-rotated corner points (still normalized) relative to the center
    half_w, half_h = w / 2, h / 2
    corners = [
        (-half_w, -half_h),  # Top-left
        ( half_w, -half_h),  # Top-right
        ( half_w,  half_h),  # Bottom-right
        (-half_w,  half_h),  # Bottom-left
    ]

    # Rotate each corner and translate it to its absolute normalized position
    cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
    pixel_corners = []
    for x_norm, y_norm in corners:
        # 2D rotation
        x_rot_norm = x_norm * cos_a - y_norm * sin_a
        y_rot_norm = x_norm * sin_a + y_norm * cos_a

        # Translate to absolute normalized position
        abs_x_norm = cx + x_rot_norm
        abs_y_norm = cy + y_rot_norm

        # Scale up to pixel coordinates
        pixel_corners.append((
            abs_x_norm * crop_width + crop_x,
            abs_y_norm * crop_height + crop_y
        ))

    # Return as x1, y1, x2, y2, x3, y3, x4, y4
    return {
        "x1": pixel_corners[0][0],
        "y1": pixel_corners[0][1],
        "x2": pixel_corners[1][0],
        "y2": pixel_corners[1][1],
        "x3": pixel_corners[2][0],
        "y3": pixel_corners[2][1],
        "x4": pixel_corners[3][0],
        "y4": pixel_corners[3][1],
    }

def extract_text_with_pixel_boxes(
    api_response: Dict[str, Any], 
    original_width: int, 
    original_height: int,
    crop_x: int,
    crop_y: int,
    crop_width: int,
    crop_height: int
) -> List[Dict[str, Any]]:
    """
    Extracts sentences and words and converts their normalized bounding boxes
    to absolute pixel coordinates based on original image dimensions.

    Args:
        api_response: The dictionary parsed from the source JSON.
        original_width: The width of the original, full-size image.
        original_height: The height of the original, full-size image.

    Returns:
        A list of sentence objects with text and bounding boxes in pixel coordinates.
    """
    results = []
    regex = get_regex(get_ocr_language())
    
    try:
        paragraphs = api_response["objects_response"]["text"]["text_layout"]["paragraphs"]
    except KeyError:
        return [] # Return empty list if the structure is not found

    for para in paragraphs:
        for line in para.get("lines", []):
            line_text_parts = []
            word_list = []
            

            for word in line.get("words", []):
                if not regex.search(word.get("plain_text", "")):
                    continue
                word_text = word.get("plain_text", "")
                line_text_parts.append(word_text)
                
                # Convert word's bounding box to pixel coordinates
                word_box = _convert_box_to_pixels_v2(
                    word["geometry"]["bounding_box"], 
                    original_width, 
                    original_height,
                    crop_x=crop_x,
                    crop_y=crop_y,
                    crop_width=crop_width,
                    crop_height=crop_height
                )
                
                word_list.append({
                    "text": word_text,
                    "bounding_rect": word_box
                })
                
            if not line_text_parts:
                continue
            
            # Assemble the sentence object
            full_sentence_text = "".join(line_text_parts)
            # Convert the full line's bounding box to pixel coordinates
            line_box = _convert_box_to_pixels_v2(
                line["geometry"]["bounding_box"], 
                original_width, 
                original_height,
                crop_x=crop_x,
                crop_y=crop_y,
                crop_width=crop_width,
                crop_height=crop_height
            )

            results.append({
                "text": full_sentence_text,
                "bounding_rect": line_box,
                "words": word_list
            })
            
    return results

# def correct_ocr_text(detected_text: str, reference_text: str) -> str:
#     """
#     Correct OCR text by comparing character-by-character with reference text.
#     When mismatches are found, look for subsequent matches and correct previous mismatches.
#     """
#     if not detected_text or not reference_text:
#         return detected_text
    
#     detected_chars = list(detected_text)
#     reference_chars = list(reference_text)
    
#     # Track positions where mismatches occurred
#     mismatched_positions = []
    
#     min_length = min(len(detected_chars), len(reference_chars))
    
#     start_of_reference = 0
#     for char in detected_chars:
#         if char == reference_chars[start_of_reference]:
#             start_of_reference += 1
    
#     for i in range(min_length):
#         if detected_chars[i] != reference_chars[i]:
#             mismatched_positions.append(i)
#             logger.info(f"Mismatch at position {i}: detected '{detected_chars[i]}' vs reference '{reference_chars[i]}'")
#         else:
#             # We found a match - if we have previous mismatches, correct the most recent one
#             if mismatched_positions:
#                 # Correct the most recent mismatch (simple 1-for-1 strategy)
#                 last_mismatch_pos = mismatched_positions.pop()
#                 old_char = detected_chars[last_mismatch_pos]
#                 detected_chars[last_mismatch_pos] = reference_chars[last_mismatch_pos]
#                 logger.info(f"Corrected position {last_mismatch_pos}: '{old_char}' -> '{reference_chars[last_mismatch_pos]}'")
    
#     corrected_text = ''.join(detected_chars)
#     return corrected_text

# def redistribute_corrected_text(original_boxes: list, original_text: str, corrected_text: str) -> list:
#     """
#     Redistribute corrected text back to the original text boxes while maintaining their positions.
#     """
#     if original_text == corrected_text:
#         return original_boxes
    
#     corrected_boxes = []
#     text_position = 0
    
#     for box in original_boxes:
#         original_word = box['text']
#         word_length = len(original_word)
        
#         # Extract the corrected portion for this box
#         if text_position + word_length <= len(corrected_text):
#             corrected_word = corrected_text[text_position:text_position + word_length]
#         else:
#             # Handle case where corrected text is shorter
#             corrected_word = corrected_text[text_position:] if text_position < len(corrected_text) else ""
        
#         # Create a new box with corrected text but same coordinates
#         corrected_box = box.copy()
#         corrected_box['text'] = corrected_word
#         corrected_boxes.append(corrected_box)
        
#         text_position += word_length
        
#         logger.info(f"Redistributed: '{original_word}' -> '{corrected_word}'")
    
#     return corrected_boxes

async def get_full_screenshot() -> Image.Image | None:
    # logger.info(f"Attempting to connect to OBS WebSocket at ws://{OBS_HOST}:{OBS_PORT}")
    # try:
    #     client = obs.ReqClient(host=OBS_HOST, port=OBS_PORT, password=OBS_PASSWORD, timeout=30)
    #     logger.info("Connected to OBS WebSocket.")
    # except Exception as e:
    #     logger.info(f"Failed to connect to OBS: {e}")
    #     return None
    #
    # try:
    #     response = client.get_source_screenshot(
    #         name=WINDOW_NAME,
    #         img_format='png',
    #         quality=75,
    #         width=WIDTH,
    #         height=HEIGHT,
    #     )
    #
    #     if not response.image_data:
    #         logger.info("Failed to get screenshot data from OBS.")
    #         return None

    logger.info("Getting Screenshot from OBS")
    try:
        import mss as mss
        start_time = time.time()
        with mss.mss() as sct:
            monitors = sct.monitors
            if len(monitors) > 1:
                monitors = monitors[1:]
            else:
                monitors = [monitors[0]]
            monitor = monitors[get_config().wip.monitor_to_capture]
            img = get_screenshot_PIL(compression=100, img_format='jpg')
            # Put the image over a transparent background without stretching
            new_img = Image.new("RGBA", (monitor['width'], monitor['height']), (0, 0, 0, 0))
            # Calculate coordinates to center img horizontally and vertically
            left = 0
            top = 0
            if img.width < monitor['width'] and img.height < monitor['height']:
                # scale image to fit monitor
                img = img.resize((monitor['width'], monitor['height']), Image.Resampling.BILINEAR)
            if img.width < monitor['width']:
                left = (monitor['width'] - img.width) // 2
            if img.height < monitor['height']:
                top = (monitor['height'] - img.height) // 2
            
            print(f"Image size: {img.size}, Monitor size: {monitor['width']}x{monitor['height']}")
            new_img.paste(img, (left, top))
            
            # new_img.show()
            
            return new_img, monitor['width'], monitor['height']
        #     sct_img = sct.grab(monitor)
        #     img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
            
        #     # img.show()
        #     return img
            # update_current_game()

            # image_data = get_screenshot_base64(compression=75, width=1280, height=720)
            # image_data = base64.b64decode(image_data)
        img = get_screenshot_PIL(img_format='jpg')
        # img = Image.open(io.BytesIO(image_data)).convert("RGBA").resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
        # img.show()
        logger.info(f"Screenshot captured in {time.time() - start_time:.2f} seconds.")

        return img

    except Exception as e:
        logger.info(f"An unexpected error occurred during screenshot capture: {e}")
        return None
    
async def do_work(sentence_to_check=None):
    # connect_to_obs_sync(5)
    logger.info("in find_box")
    # await asyncio.sleep(.5)
    logger.info("after_initial_sleep")
    full_screenshot_image, monitor_width, monitor_height = await get_full_screenshot()
    
    oneocr_results = oneocr(full_screenshot_image)
    crop_coords = oneocr_results[2]
    logger.info("Cropping full screenshot with coordinates: %s", crop_coords)
    cropped_image = full_screenshot_image.crop(crop_coords)
    # Convert 1/4
    if os.path.exists("C:\\Users\\Beangate\\GSM\\temp"):
        cropped_image.save("C:\\Users\\Beangate\\GSM\\temp\\full_screenshot.png")
    # full_screenshot_image.show()
    if cropped_image:
        logger.info("Full screenshot captured successfully. Now performing local OCR...")
        # ocr_results = oneocr(full_screenshot_image, return_coords=True)
        google_ocr_results = lens(cropped_image, return_coords=True)[2]
        
        ret = extract_text_with_pixel_boxes(
            api_response=google_ocr_results, 
            original_width=monitor_width, 
            original_height=monitor_height,
            crop_x=crop_coords[0],
            crop_y=crop_coords[1],
            crop_width=crop_coords[2] - crop_coords[0],
            crop_height=crop_coords[3] - crop_coords[1]
        )

        # boxes_of_text = google_ocr_results[2]
        # logger.info(f"Boxes of text found: {boxes_of_text}")
        
        words = []
        
        # logger.info(json.dumps(ret, indent=4, ensure_ascii=False))
        
        return ret, 48
        
        # If we have a reference sentence, perform character-by-character correction
        # if sentence_to_check:
        #     # Concatenate all OCR text to form the detected sentence
        #     detected_sentence = ''.join([box['text'] for box in boxes_of_text])
        #     logger.info(f"Original detected sentence: '{detected_sentence}'")
        #     logger.info(f"Reference sentence: '{sentence_to_check}'")
            
        #     # Perform character-by-character comparison and correction
        #     corrected_sentence = correct_ocr_text(detected_sentence, sentence_to_check)
        #     logger.info(f"Corrected sentence: '{corrected_sentence}'")
            
        #     # Redistribute corrected text back to boxes while maintaining positions
        #     corrected_boxes = redistribute_corrected_text(boxes_of_text, detected_sentence, corrected_sentence)
        # else:
        #     corrected_boxes = boxes_of_text
        
        # sentence_position = 0
        # for box in corrected_boxes:
        #     word = box['text']
        #     # logger.info(f"Box: {box}")
        #     x1, y1 = box['bounding_rect']['x1'], box['bounding_rect']['y1']
        #     x2, y2 = box['bounding_rect']['x3'], box['bounding_rect']['y3']
        #     words.append({
        #         "x1": x1,
        #         "y1": y1,
        #         "x2": x2,
        #         "y2": y2,
        #         "word": box['text']
        #     })
        
        # # logger.info(f"Returning words: {words}")
        
        # ret = [
        #     {
        #         "words": words,
        #     }
        # ]
        # cropped_sections = []
        # for box in boxes_of_text:
        #     # Ensure crop coordinates are within image bounds
        #     left = max(0, box['bounding_rect']['x1'])
        #     top = max(0, box['bounding_rect']['y1'])
        #     right = min(full_screenshot_image.width, box['bounding_rect']['x3'])
        #     bottom = min(full_screenshot_image.height, box['bounding_rect']['y3'])
        #     cropped_sections.append(full_screenshot_image.crop((left, top, right, bottom)))

        # if len(cropped_sections) > 1:
        #     # Create a transparent image with the same size as the full screenshot
        #     combined_img = Image.new("RGBA", (full_screenshot_image.width, full_screenshot_image.height), (0, 0, 0, 0))

        #     combined_img.show()

        #     # Paste each cropped section at its original coordinates
        #     for box, section in zip(boxes_of_text, cropped_sections):
        #         left = max(0, box['bounding_rect']['x1'])
        #         top = max(0, box['bounding_rect']['y1'])
        #         combined_img.paste(section, (left, top))

        #     new_image = combined_img
        # elif cropped_sections:
        #     new_image = cropped_sections[0]
        # else:
        #     new_image = Image.new("RGBA", full_screenshot_image.size)

        # new_image.show()
        # ocr_results = lens(new_image, return_coords=True)
        # ocr_results = oneocr(full_screenshot_image, sentence_to_check=sentence_to_check)
        # logger.info("\n--- OCR Results ---")
        # logger.info(ocr_results)

        return ret, 48
        # from PIL import ImageDraw
        # draw = ImageDraw.Draw(full_screenshot_image)
        # draw.rectangle([x1, y1, x2, y2], outline="red", width=3)
        # full_screenshot_image.save("full_screenshot_with_ocr.png")
        # full_screenshot_image.show()
        #
        # logger.info(ocr_results)
        # if ocr_results:
        #     for i, result in enumerate(ocr_results):
        #         logger.info(f"Result {i + 1}:\n{result}\n")
        # else:
        #     logger.info("No OCR results found.")
    else:
        logger.info("Failed to get full screenshot for OCR.")

async def find_box_for_sentence(sentence_to_check):
    try:
        return await do_work(sentence_to_check=sentence_to_check)
    except Exception as e:
        logger.info(f"Error in find_box_for_sentence: {e}", exc_info=True)
        return [], 48

async def main():
    import mss as mss
    connect_to_obs_sync(5)
    start_time = time.time()
    with mss.mss() as sct:
        monitors = sct.monitors
        if len(monitors) > 1:
            monitors = monitors[1:]
        else:
            monitors = [monitors[0]]
        monitor = monitors[get_config().wip.monitor_to_capture]
        img = get_screenshot_PIL(img_format='jpg')
        img.show()
        # Put the image over a transparent background without stretching
        # Create a transparent image with the same size as the monitor
        new_img = Image.new("RGBA", (monitor['width'], monitor['height']), (0, 0, 0, 0))
        # Calculate coordinates to center img horizontally and vertically
        left = (monitor['width'] - img.width) // 2
        top = (monitor['height'] - img.height) // 2
        print(f"Image size: {img.size}, Monitor size: {monitor['width']}x{monitor['height']}")
        print(f"Left: {left}, Top: {top}, Width: {monitor['width']}, Height: {monitor['height']}")
        new_img.paste(img, (left, top))
        new_img.show()
        
        return new_img

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Script terminated by user.")