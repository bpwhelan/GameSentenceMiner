import asyncio
import io
import base64
from PIL import Image
from GameSentenceMiner.util.configuration import get_config

if get_config().wip.overlay_websocket_send:
    from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, OneOCR
from GameSentenceMiner.obs import *

# OBS WebSocket settings
OBS_HOST = 'localhost'
OBS_PORT = 7274
OBS_PASSWORD = 'your_obs_websocket_password' # Set your OBS WebSocket password here, if any

WINDOW_NAME = "Nier:Automata"
WIDTH = 2560
HEIGHT = 1440
if get_config().wip.overlay_websocket_send:
    oneocr = OneOCR()
    lens = GoogleLens()

def correct_ocr_text(detected_text: str, reference_text: str) -> str:
    """
    Correct OCR text by comparing character-by-character with reference text.
    When mismatches are found, look for subsequent matches and correct previous mismatches.
    """
    if not detected_text or not reference_text:
        return detected_text
    
    detected_chars = list(detected_text)
    reference_chars = list(reference_text)
    
    # Track positions where mismatches occurred
    mismatched_positions = []
    
    min_length = min(len(detected_chars), len(reference_chars))
    
    for i in range(min_length):
        if detected_chars[i] != reference_chars[i]:
            mismatched_positions.append(i)
            logger.info(f"Mismatch at position {i}: detected '{detected_chars[i]}' vs reference '{reference_chars[i]}'")
        else:
            # We found a match - if we have previous mismatches, correct the most recent one
            if mismatched_positions:
                # Correct the most recent mismatch (simple 1-for-1 strategy)
                last_mismatch_pos = mismatched_positions.pop()
                old_char = detected_chars[last_mismatch_pos]
                detected_chars[last_mismatch_pos] = reference_chars[last_mismatch_pos]
                logger.info(f"Corrected position {last_mismatch_pos}: '{old_char}' -> '{reference_chars[last_mismatch_pos]}'")
    
    corrected_text = ''.join(detected_chars)
    return corrected_text

def redistribute_corrected_text(original_boxes: list, original_text: str, corrected_text: str) -> list:
    """
    Redistribute corrected text back to the original text boxes while maintaining their positions.
    """
    if original_text == corrected_text:
        return original_boxes
    
    corrected_boxes = []
    text_position = 0
    
    for box in original_boxes:
        original_word = box['text']
        word_length = len(original_word)
        
        # Extract the corrected portion for this box
        if text_position + word_length <= len(corrected_text):
            corrected_word = corrected_text[text_position:text_position + word_length]
        else:
            # Handle case where corrected text is shorter
            corrected_word = corrected_text[text_position:] if text_position < len(corrected_text) else ""
        
        # Create a new box with corrected text but same coordinates
        corrected_box = box.copy()
        corrected_box['text'] = corrected_word
        corrected_boxes.append(corrected_box)
        
        text_position += word_length
        
        logger.info(f"Redistributed: '{original_word}' -> '{corrected_word}'")
    
    return corrected_boxes

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
            sct_img = sct.grab(monitor)
            img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
            # img.show()
            return img
            # update_current_game()

            # image_data = get_screenshot_base64(compression=75, width=1280, height=720)
            # image_data = base64.b64decode(image_data)
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
    full_screenshot_image = await get_full_screenshot()
    if os.path.exists("C:\\Users\\Beangate\\GSM\\temp"):
        full_screenshot_image.save("C:\\Users\\Beangate\\GSM\\temp\\full_screenshot.png")
    # full_screenshot_image.show()
    if full_screenshot_image:
        logger.info("Full screenshot captured successfully. Now performing local OCR...")
        ocr_results = oneocr(full_screenshot_image, return_coords=True)
        
        boxes_of_text = ocr_results[2]
        # logger.info(f"Boxes of text found: {boxes_of_text}")
        
        words = []
        
        # If we have a reference sentence, perform character-by-character correction
        if sentence_to_check:
            # Concatenate all OCR text to form the detected sentence
            detected_sentence = ''.join([box['text'] for box in boxes_of_text])
            logger.info(f"Original detected sentence: '{detected_sentence}'")
            logger.info(f"Reference sentence: '{sentence_to_check}'")
            
            # Perform character-by-character comparison and correction
            corrected_sentence = correct_ocr_text(detected_sentence, sentence_to_check)
            logger.info(f"Corrected sentence: '{corrected_sentence}'")
            
            # Redistribute corrected text back to boxes while maintaining positions
            corrected_boxes = redistribute_corrected_text(boxes_of_text, detected_sentence, corrected_sentence)
        else:
            corrected_boxes = boxes_of_text
        
        sentence_position = 0
        for box in corrected_boxes:
            word = box['text']
            # logger.info(f"Box: {box}")
            x1, y1 = box['bounding_rect']['x1'], box['bounding_rect']['y1']
            x2, y2 = box['bounding_rect']['x3'], box['bounding_rect']['y3']
            words.append({
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "word": box['text']
            })
        
        # logger.info(f"Returning words: {words}")
        
        ret = [
            {
                "words": words,
            }
        ]
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
    connect_to_obs_sync(5)
    await find_box_for_sentence("はじめから")

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Script terminated by user.")