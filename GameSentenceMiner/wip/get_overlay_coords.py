import asyncio
import io
import base64
from PIL import Image
import obsws_python as obs

from GameSentenceMiner.owocr.owocr.ocr import *
from GameSentenceMiner.obs import *

# OBS WebSocket settings
OBS_HOST = 'localhost'
OBS_PORT = 7274
OBS_PASSWORD = 'your_obs_websocket_password' # Set your OBS WebSocket password here, if any

WINDOW_NAME = "Nier:Automata"
WIDTH = 2560
HEIGHT = 1440
oneocr = OneOCR()

async def get_full_screenshot() -> Image.Image | None:
    # print(f"Attempting to connect to OBS WebSocket at ws://{OBS_HOST}:{OBS_PORT}")
    # try:
    #     client = obs.ReqClient(host=OBS_HOST, port=OBS_PORT, password=OBS_PASSWORD, timeout=30)
    #     print("Connected to OBS WebSocket.")
    # except Exception as e:
    #     print(f"Failed to connect to OBS: {e}")
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
    #         print("Failed to get screenshot data from OBS.")
    #         return None
    #

    print("Getting Screenshot from OBS")
    try:
        start_time = time.time()
        image_data = get_screenshot_base64(compression=75, width=1280, height=720)
        image_data = base64.b64decode(image_data.split(",")[1])
        img = Image.open(io.BytesIO(image_data)).convert("RGBA").resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
        # img.show()
        print(f"Screenshot captured in {time.time() - start_time:.2f} seconds.")

        return img

    except Exception as e:
        print(f"An unexpected error occurred during screenshot capture: {e}")
        return None

async def find_box_for_sentence(sentence_to_check):
    # connect_to_obs_sync(5)
    print("in find_box")
    await asyncio.sleep(.5)
    print("after_initial_sleep")
    full_screenshot_image = await get_full_screenshot()
    if full_screenshot_image:
        print("Full screenshot captured successfully. Now performing local OCR...")
        ocr_results = oneocr(full_screenshot_image, sentence_to_check=sentence_to_check)
        print("\n--- OCR Results ---")
        print(ocr_results)

        return ocr_results[2], 48
        # from PIL import ImageDraw
        # draw = ImageDraw.Draw(full_screenshot_image)
        # draw.rectangle([x1, y1, x2, y2], outline="red", width=3)
        # full_screenshot_image.save("full_screenshot_with_ocr.png")
        # full_screenshot_image.show()
        #
        # print(ocr_results)
        # if ocr_results:
        #     for i, result in enumerate(ocr_results):
        #         print(f"Result {i + 1}:\n{result}\n")
        # else:
        #     print("No OCR results found.")
    else:
        print("Failed to get full screenshot for OCR.")

async def main():
    await find_box_for_sentence("はじめから")

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Script terminated by user.")