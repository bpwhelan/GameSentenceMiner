import os
import sys

from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness, get_scene_ocr_config
from GameSentenceMiner.util.gsm_utils import do_text_replacements, OCR_REPLACEMENTS_FILE
from GameSentenceMiner.util.electron_config import get_ocr_language, get_ocr_requires_open_window, \
    has_ocr_config_changed, reload_electron_config, get_ocr_scan_rate, get_ocr_two_pass_ocr, get_ocr_keep_newline, \
    get_ocr_ocr1, get_furigana_filter_sensitivity

try:
    import win32gui
    import win32ui
    import win32api
    import win32con
    import win32process
    import win32clipboard
    import pywintypes
    import ctypes
except ImportError:
    pass

try:
    import objc
    import platform
    from AppKit import NSData, NSImage, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSZeroPoint, NSZeroRect, NSCompositingOperationCopy
    from Quartz import CGWindowListCreateImageFromArray, kCGWindowImageBoundsIgnoreFraming, CGRectMake, CGRectNull, CGMainDisplayID, CGWindowListCopyWindowInfo, \
        CGWindowListCreateDescriptionFromArray, kCGWindowListOptionOnScreenOnly, kCGWindowListExcludeDesktopElements, kCGWindowName, kCGNullWindowID, \
        CGImageGetWidth, CGImageGetHeight, CGDataProviderCopyData, CGImageGetDataProvider, CGImageGetBytesPerRow
    from ScreenCaptureKit import SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCCaptureResolutionBest
except ImportError:
    pass

import signal
import threading
from pathlib import Path
import queue
import re
import logging
import inspect
import time

import pyperclipfix
import mss
import asyncio
import websockets
import socketserver
import cv2
import numpy as np

from collections import deque
from datetime import datetime, timedelta
from PIL import Image, ImageDraw
from loguru import logger
from desktop_notifier import DesktopNotifierSync
import psutil

from .ocr import *  # noqa: F403
from .config import Config
from .screen_coordinate_picker import get_screen_selection
from GameSentenceMiner.util.configuration import get_config, get_temporary_directory

from skimage.metrics import structural_similarity as ssim
from typing import Union

config = None
last_image = None
last_image_np = None


class ClipboardThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.ignore_flag = config.get_general('ignore_flag')
        self.delay_secs = config.get_general('delay_secs')
        self.last_update = time.time()

    def are_images_identical(self, img1, img2):
        if None in (img1, img2):
            return img1 == img2

        img1 = np.array(img1)
        img2 = np.array(img2)

        return (img1.shape == img2.shape) and (img1 == img2).all()

    def normalize_macos_clipboard(self, img):
        ns_data = NSData.dataWithBytes_length_(img, len(img))
        ns_image = NSImage.alloc().initWithData_(ns_data)

        new_image = NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
            None,  # Set to None to create a new bitmap
            int(ns_image.size().width),
            int(ns_image.size().height),
            8,  # Bits per sample
            4,  # Samples per pixel (R, G, B, A)
            True,  # Has alpha
            False,  # Is not planar
            NSDeviceRGBColorSpace,
            0,  # Automatically compute bytes per row
            32  # Bits per pixel (8 bits per sample * 4 samples per pixel)
        )

        context = NSGraphicsContext.graphicsContextWithBitmapImageRep_(
            new_image)
        NSGraphicsContext.setCurrentContext_(context)

        ns_image.drawAtPoint_fromRect_operation_fraction_(
            NSZeroPoint,
            NSZeroRect,
            NSCompositingOperationCopy,
            1.0
        )

        return bytes(new_image.TIFFRepresentation())

    def process_message(self, hwnd: int, msg: int, wparam: int, lparam: int):
        WM_CLIPBOARDUPDATE = 0x031D
        timestamp = time.time()
        if msg == WM_CLIPBOARDUPDATE and timestamp - self.last_update > 1 and not paused:
            self.last_update = timestamp
            while True:
                try:
                    win32clipboard.OpenClipboard()
                    break
                except pywintypes.error:
                    pass
                time.sleep(0.1)
            try:
                if win32clipboard.IsClipboardFormatAvailable(win32con.CF_BITMAP) and win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_DIB):
                    clipboard_text = ''
                    if win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_UNICODETEXT):
                        clipboard_text = win32clipboard.GetClipboardData(
                            win32clipboard.CF_UNICODETEXT)
                    if self.ignore_flag or clipboard_text != '*ocr_ignore*':
                        img = win32clipboard.GetClipboardData(
                            win32clipboard.CF_DIB)
                        image_queue.put((img, False))
                win32clipboard.CloseClipboard()
            except pywintypes.error:
                pass
        return 0

    def create_window(self):
        className = 'ClipboardHook'
        wc = win32gui.WNDCLASS()
        wc.lpfnWndProc = self.process_message
        wc.lpszClassName = className
        wc.hInstance = win32api.GetModuleHandle(None)
        class_atom = win32gui.RegisterClass(wc)
        return win32gui.CreateWindow(class_atom, className, 0, 0, 0, 0, 0, 0, 0, wc.hInstance, None)

    def run(self):
        if sys.platform == 'win32':
            hwnd = self.create_window()
            self.thread_id = win32api.GetCurrentThreadId()
            ctypes.windll.user32.AddClipboardFormatListener(hwnd)
            win32gui.PumpMessages()
        else:
            is_macos = sys.platform == 'darwin'
            if is_macos:
                from AppKit import NSPasteboard, NSPasteboardTypeTIFF, NSPasteboardTypeString
                pasteboard = NSPasteboard.generalPasteboard()
                count = pasteboard.changeCount()
            else:
                from PIL import ImageGrab
            process_clipboard = False
            img = None

            while not terminated:
                if paused:
                    sleep_time = 0.5
                    process_clipboard = False
                else:
                    sleep_time = self.delay_secs
                    if is_macos:
                        with objc.autorelease_pool():
                            old_count = count
                            count = pasteboard.changeCount()
                            if process_clipboard and count != old_count:
                                while len(pasteboard.types()) == 0:
                                    time.sleep(0.1)
                                if NSPasteboardTypeTIFF in pasteboard.types():
                                    clipboard_text = ''
                                    if NSPasteboardTypeString in pasteboard.types():
                                        clipboard_text = pasteboard.stringForType_(
                                            NSPasteboardTypeString)
                                    if self.ignore_flag or clipboard_text != '*ocr_ignore*':
                                        img = self.normalize_macos_clipboard(
                                            pasteboard.dataForType_(NSPasteboardTypeTIFF))
                                        image_queue.put((img, False))
                    else:
                        old_img = img
                        try:
                            img = ImageGrab.grabclipboard()
                        except Exception:
                            pass
                        else:
                            if (process_clipboard and isinstance(img, Image.Image) and
                                    (self.ignore_flag or pyperclipfix.paste() != '*ocr_ignore*') and
                                    (not self.are_images_identical(img, old_img))):
                                image_queue.put((img, False))

                    process_clipboard = True

                if not terminated:
                    time.sleep(sleep_time)


class DirectoryWatcher(threading.Thread):
    def __init__(self, path):
        super().__init__(daemon=True)
        self.path = path
        self.delay_secs = config.get_general('delay_secs')
        self.last_update = time.time()
        self.allowed_extensions = (
            '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp')

    def get_path_key(self, path):
        return path, path.lstat().st_mtime

    def run(self):
        old_paths = set()
        for path in self.path.iterdir():
            if path.suffix.lower() in self.allowed_extensions:
                old_paths.add(get_path_key(path))

        while not terminated:
            if paused:
                sleep_time = 0.5
            else:
                sleep_time = self.delay_secs
                for path in self.path.iterdir():
                    if path.suffix.lower() in self.allowed_extensions:
                        path_key = self.get_path_key(path)
                        if path_key not in old_paths:
                            old_paths.add(path_key)

                            if not paused:
                                image_queue.put((path, False))

            if not terminated:
                time.sleep(sleep_time)


class WebsocketServerThread(threading.Thread):
    def __init__(self, read):
        super().__init__(daemon=True)
        self._loop = None
        self.read = read
        self.clients = set()
        self._event = threading.Event()

    @property
    def loop(self):
        self._event.wait()
        return self._loop

    async def send_text_coroutine(self, text):
        for client in self.clients:
            await client.send(text)

    async def server_handler(self, websocket):
        self.clients.add(websocket)
        try:
            async for message in websocket:
                if self.read and not paused:
                    image_queue.put((message, False))
                    try:
                        await websocket.send('True')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                else:
                    try:
                        await websocket.send('False')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
        except websockets.exceptions.ConnectionClosedError:
            pass
        finally:
            self.clients.remove(websocket)

    def send_text(self, text):
        return asyncio.run_coroutine_threadsafe(self.send_text_coroutine(text), self.loop)

    def stop_server(self):
        self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            self.server = start_server = websockets.serve(
                self.server_handler, get_config().advanced.localhost_bind_address, config.get_general('websocket_port'), max_size=1000000000)
            async with start_server:
                await stop_event.wait()
        asyncio.run(main())


class RequestHandler(socketserver.BaseRequestHandler):
    def handle(self):
        conn = self.request
        conn.settimeout(3)
        data = conn.recv(4)
        img_size = int.from_bytes(data)
        img = bytearray()
        try:
            while len(img) < img_size:
                data = conn.recv(4096)
                if not data:
                    break
                img.extend(data)
        except TimeoutError:
            pass

        if not paused:
            image_queue.put((img, False))
            conn.sendall(b'True')
        else:
            conn.sendall(b'False')


class PassthroughSegmenter:
    def segment(self, text):
        return [text]

class TextFiltering:
    accurate_filtering = False

    def __init__(self, lang='ja'):
        from pysbd import Segmenter, languages
        self.initial_lang = get_ocr_language() or lang
        if lang in languages.LANGUAGE_CODES:
            self.segmenter = Segmenter(language=lang, clean=True)
        else:
            self.segmenter = PassthroughSegmenter()
        self.kana_kanji_regex = re.compile(
            r'[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]')
        self.chinese_common_regex = re.compile(r'[\u4E00-\u9FFF]')
        self.english_regex = re.compile(r'[a-zA-Z0-9.,!?;:"\'()\[\]{}]')
        self.chinese_common_regex = re.compile(r'[\u4E00-\u9FFF]')
        self.english_regex = re.compile(r'[a-zA-Z0-9.,!?;:"\'()\[\]{}]')
        self.korean_regex = re.compile(r'[\uAC00-\uD7AF]')
        self.arabic_regex = re.compile(
            r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]')
        self.russian_regex = re.compile(
            r'[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F\u1C80-\u1C8F]')
        self.greek_regex = re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF]')
        self.hebrew_regex = re.compile(r'[\u0590-\u05FF\uFB1D-\uFB4F]')
        self.thai_regex = re.compile(r'[\u0E00-\u0E7F]')
        self.latin_extended_regex = re.compile(
            r'[a-zA-Z\u00C0-\u00FF\u0100-\u017F\u0180-\u024F\u0250-\u02AF\u1D00-\u1D7F\u1D80-\u1DBF\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\uAB30-\uAB6F]')
        self.last_few_results = {}
        try:
            from transformers import pipeline, AutoTokenizer
            import torch
            logging.getLogger('transformers').setLevel(logging.ERROR)

            model_ckpt = 'papluca/xlm-roberta-base-language-detection'
            tokenizer = AutoTokenizer.from_pretrained(
                model_ckpt,
                use_fast=False
            )

            if torch.cuda.is_available():
                device = 0
            elif torch.backends.mps.is_available():
                device = 'mps'
            else:
                device = -1
            self.pipe = pipeline(
                'text-classification', model=model_ckpt, tokenizer=tokenizer, device=device)
            self.accurate_filtering = True
        except:
            import langid
            self.classify = langid.classify

    def __call__(self, text, last_result, engine=None, is_second_ocr=False):
        lang = get_ocr_language()
        if self.initial_lang != lang:
            from pysbd import Segmenter, languages
            if lang in languages.LANGUAGE_CODES:
                self.segmenter = Segmenter(language=lang, clean=True)
            else:
                self.segmenter = PassthroughSegmenter()
            self.initial_lang = get_ocr_language()

        orig_text = self.segmenter.segment(text)
        orig_text_filtered = []
        for block in orig_text:
            if "BLANK_LINE" in block:
                block_filtered = ["\n"]
            elif lang == "ja":
                block_filtered = self.kana_kanji_regex.findall(block)
            elif lang == "zh":
                block_filtered = self.chinese_common_regex.findall(block)
            elif lang == "ko":
                block_filtered = self.korean_regex.findall(block)
            elif lang == "ar":
                block_filtered = self.arabic_regex.findall(block)
            elif lang == "ru":
                block_filtered = self.russian_regex.findall(block)
            elif lang == "el":
                block_filtered = self.greek_regex.findall(block)
            elif lang == "he":
                block_filtered = self.hebrew_regex.findall(block)
            elif lang == "th":
                block_filtered = self.thai_regex.findall(block)
            elif lang in ["en", "fr", "de", "es", "it", "pt", "nl", "sv", "da", "no",
                          "fi"]:  # Many European languages use extended Latin
                block_filtered = self.latin_extended_regex.findall(block)
            else:
                block_filtered = self.latin_extended_regex.findall(block)

            if block_filtered:
                orig_text_filtered.append(''.join(block_filtered))
            else:
                orig_text_filtered.append(None)

        try:
            if isinstance(last_result, list):
                last_text = last_result.copy()
            elif last_result and last_result[1] == engine_index:
                last_text = last_result[0]
            else:
                last_text = []
            
            if engine and not is_second_ocr:
                if self.last_few_results and self.last_few_results.get(engine):
                    for sublist in self.last_few_results.get(engine, []):
                        if sublist:
                            for item in sublist:
                                if item and item not in last_text:
                                    last_text.append(item)
                    self.last_few_results[engine].append(orig_text_filtered)
                else:
                    self.last_few_results[engine] = deque(maxlen=3)
                    self.last_few_results[engine].append(orig_text_filtered)

        except Exception as e:
            logger.error(f"Error processing last_result {last_result}: {e}")
            last_text = []

        new_blocks = []
        for idx, block in enumerate(orig_text):
            if orig_text_filtered[idx] and (orig_text_filtered[idx] not in last_text):
                new_blocks.append(
                    str(block).strip().replace("BLANK_LINE", "\n"))

        final_blocks = []
        if self.accurate_filtering:
            detection_results = self.pipe(new_blocks, top_k=3, truncation=True)
            for idx, block in enumerate(new_blocks):
                for result in detection_results[idx]:
                    if result['label'] == lang:
                        final_blocks.append(block)
                        break
        else:
            for block in new_blocks:
                # This only filters out NON JA/ZH from text when lang is JA/ZH
                if lang not in ["ja", "zh"] or self.classify(block)[0] in ['ja', 'zh'] or block == "\n":
                    final_blocks.append(block)

        text = '\n'.join(final_blocks)
        return text, orig_text_filtered


class ScreenshotThread(threading.Thread):
    def __init__(self, screen_capture_area, screen_capture_window, ocr_config, screen_capture_on_combo):
        super().__init__(daemon=True)
        self.macos_window_tracker_instance = None
        self.windows_window_tracker_instance = None
        self.screencapture_window_active = True
        self.screencapture_window_visible = True
        self.custom_left = None
        self.screen_capture_window = screen_capture_window
        self.areas = []
        self.use_periodic_queue = not screen_capture_on_combo
        self.ocr_config = ocr_config
        if screen_capture_area == '':
            self.screencapture_mode = 0
        elif screen_capture_area.startswith('screen_'):
            parts = screen_capture_area.split('_')
            if len(parts) != 2 or not parts[1].isdigit():
                raise ValueError('Invalid screen_capture_area')
            screen_capture_monitor = int(parts[1])
            self.screencapture_mode = 1
        elif len(screen_capture_area.split(',')) == 4:
            self.screencapture_mode = 3
        else:
            self.screencapture_mode = 2
            self.screen_capture_window = screen_capture_area
        if self.screen_capture_window:
            self.screencapture_mode = 2

        if self.screencapture_mode != 2:
            sct = mss.mss()

            if self.screencapture_mode == 1:
                mon = sct.monitors
                if len(mon) <= screen_capture_monitor:
                    raise ValueError(
                        'Invalid monitor number in screen_capture_area')
                coord_left = mon[screen_capture_monitor]['left']
                coord_top = mon[screen_capture_monitor]['top']
                coord_width = mon[screen_capture_monitor]['width']
                coord_height = mon[screen_capture_monitor]['height']
            elif self.screencapture_mode == 3:
                coord_left, coord_top, coord_width, coord_height = [
                    int(c.strip()) for c in screen_capture_area.split(',')]
            else:
                logger.opt(ansi=True).info(
                    'Launching screen coordinate picker')
                screen_selection = get_screen_selection()
                if not screen_selection:
                    raise ValueError(
                        'Picker window was closed or an error occurred')
                screen_capture_monitor = screen_selection['monitor']
                x, y, coord_width, coord_height = screen_selection['coordinates']
                if coord_width > 0 and coord_height > 0:
                    coord_top = screen_capture_monitor['top'] + y
                    coord_left = screen_capture_monitor['left'] + x
                else:
                    logger.opt(ansi=True).info(
                        'Selection is empty, selecting whole screen')
                    coord_left = screen_capture_monitor['left']
                    coord_top = screen_capture_monitor['top']
                    coord_width = screen_capture_monitor['width']
                    coord_height = screen_capture_monitor['height']

            self.sct_params = {'top': coord_top, 'left': coord_left,
                               'width': coord_width, 'height': coord_height}
            logger.opt(ansi=True).info(
                f'Selected coordinates: {coord_left},{coord_top},{coord_width},{coord_height}')
        else:
            if len(screen_capture_area.split(',')) == 4:
                self.areas.append(([int(c.strip())
                                  for c in screen_capture_area.split(',')]))

        self.areas.sort(key=lambda rect: (rect[1], rect[0]))

        if self.screencapture_mode == 2 or self.screen_capture_window:
            area_invalid_error = '"screen_capture_area" must be empty, "screen_N" where N is a screen number starting from 1, a valid set of coordinates, or a valid window name'
            if sys.platform == 'darwin':
                if config.get_general('screen_capture_old_macos_api') or int(platform.mac_ver()[0].split('.')[0]) < 14:
                    self.old_macos_screenshot_api = True
                else:
                    self.old_macos_screenshot_api = False
                    self.screencapturekit_queue = queue.Queue()
                    CGMainDisplayID()
                window_list = CGWindowListCopyWindowInfo(
                    kCGWindowListExcludeDesktopElements, kCGNullWindowID)
                window_titles = []
                window_ids = []
                window_index = None
                for i, window in enumerate(window_list):
                    window_title = window.get(kCGWindowName, '')
                    if psutil.Process(window['kCGWindowOwnerPID']).name() not in ('Terminal', 'iTerm2'):
                        window_titles.append(window_title)
                        window_ids.append(window['kCGWindowNumber'])

                if screen_capture_window in window_titles:
                    window_index = window_titles.index(screen_capture_window)
                else:
                    for t in window_titles:
                        if screen_capture_window in t:
                            window_index = window_titles.index(t)
                            break

                if not window_index:
                    raise ValueError(area_invalid_error)

                self.window_id = window_ids[window_index]
                window_title = window_titles[window_index]

                if get_ocr_requires_open_window():
                    self.macos_window_tracker_instance = threading.Thread(
                        target=self.macos_window_tracker)
                    self.macos_window_tracker_instance.start()
                logger.opt(ansi=True).info(f'Selected window: {window_title}')
            elif sys.platform == 'win32':
                self.window_handle, window_title = self.get_windows_window_handle(
                    screen_capture_window)

                if not self.window_handle:
                    raise ValueError(area_invalid_error)

                set_dpi_awareness()

                self.windows_window_tracker_instance = threading.Thread(
                    target=self.windows_window_tracker)
                self.windows_window_tracker_instance.start()
                logger.opt(ansi=True).info(f'Selected window: {window_title}')
            else:
                raise ValueError(
                    'Window capture is only currently supported on Windows and macOS')

    def get_windows_window_handle(self, window_title):
        def callback(hwnd, window_title_part):
            window_title = win32gui.GetWindowText(hwnd)
            if window_title_part in window_title:
                handles.append((hwnd, window_title))
            return True

        handle = win32gui.FindWindow(None, window_title)
        if handle:
            return (handle, window_title)

        handles = []
        win32gui.EnumWindows(callback, window_title)
        for handle in handles:
            _, pid = win32process.GetWindowThreadProcessId(handle[0])
            if psutil.Process(pid).name().lower() not in ('cmd.exe', 'powershell.exe', 'windowsterminal.exe'):
                return handle

        return (None, None)

    def windows_window_tracker(self):
        found = True
        while not terminated:
            found = win32gui.IsWindow(self.window_handle)
            if not found:
                break
            if get_ocr_requires_open_window():
                self.screencapture_window_active = self.window_handle == win32gui.GetForegroundWindow()
            else:
                self.screencapture_window_visible = not win32gui.IsIconic(
                    self.window_handle)
            time.sleep(0.2)
        if not found:
            on_window_closed(False)

    def capture_macos_window_screenshot(self, window_id):
        def shareable_content_completion_handler(shareable_content, error):
            if error:
                self.screencapturekit_queue.put(None)
                return

            target_window = None
            for window in shareable_content.windows():
                if window.windowID() == window_id:
                    target_window = window
                    break

            if not target_window:
                self.screencapturekit_queue.put(None)
                return

            with objc.autorelease_pool():
                content_filter = SCContentFilter.alloc(
                ).initWithDesktopIndependentWindow_(target_window)

                frame = content_filter.contentRect()
                scale = content_filter.pointPixelScale()
                width = frame.size.width * scale
                height = frame.size.height * scale
                configuration = SCStreamConfiguration.alloc().init()
                configuration.setSourceRect_(CGRectMake(
                    0, 0, frame.size.width, frame.size.height))
                configuration.setWidth_(width)
                configuration.setHeight_(height)
                configuration.setShowsCursor_(False)
                configuration.setCaptureResolution_(SCCaptureResolutionBest)
                configuration.setIgnoreGlobalClipSingleWindow_(True)

                SCScreenshotManager.captureImageWithFilter_configuration_completionHandler_(
                    content_filter, configuration, capture_image_completion_handler
                )

        def capture_image_completion_handler(image, error):
            if error:
                self.screencapturekit_queue.put(None)
                return

            self.screencapturekit_queue.put(image)

        SCShareableContent.getShareableContentWithCompletionHandler_(
            shareable_content_completion_handler
        )

    def macos_window_tracker(self):
        found = True
        while found and not terminated:
            found = False
            is_active = False
            with objc.autorelease_pool():
                window_list = CGWindowListCopyWindowInfo(
                    kCGWindowListOptionOnScreenOnly, kCGNullWindowID)
                for i, window in enumerate(window_list):
                    if found and window.get(kCGWindowName, '') == 'Fullscreen Backdrop':
                        is_active = True
                        break
                    if self.window_id == window['kCGWindowNumber']:
                        found = True
                        if i == 0 or window_list[i-1].get(kCGWindowName, '') in ('Dock', 'Color Enforcer Window'):
                            is_active = True
                            break
                if not found:
                    window_list = CGWindowListCreateDescriptionFromArray(
                        [self.window_id])
                    if len(window_list) > 0:
                        found = True
            if found:
                self.screencapture_window_active = is_active
            time.sleep(0.2)
        if not found:
            on_window_closed(False)

    def write_result(self, result):
        if self.use_periodic_queue:
            periodic_screenshot_queue.put(result)
        else:
            image_queue.put((result, True))

    def run(self):
        if self.screencapture_mode != 2:
            sct = mss.mss()
        start = time.time()
        while not terminated:
            if time.time() - start > 1:
                start = time.time()
                section_changed = has_ocr_config_changed()
                if section_changed:
                    reload_electron_config()

            if not screenshot_event.wait(timeout=0.1):
                continue
            if self.screencapture_mode == 2 or self.screen_capture_window:
                if sys.platform == 'darwin':
                    with objc.autorelease_pool():
                        if self.old_macos_screenshot_api:
                            cg_image = CGWindowListCreateImageFromArray(CGRectNull, [self.window_id],
                                                                        kCGWindowImageBoundsIgnoreFraming)
                        else:
                            self.capture_macos_window_screenshot(
                                self.window_id)
                            try:
                                cg_image = self.screencapturekit_queue.get(
                                    timeout=0.5)
                            except queue.Empty:
                                cg_image = None
                        if not cg_image:
                            return 0
                        width = CGImageGetWidth(cg_image)
                        height = CGImageGetHeight(cg_image)
                        raw_data = CGDataProviderCopyData(
                            CGImageGetDataProvider(cg_image))
                        bpr = CGImageGetBytesPerRow(cg_image)
                    img = Image.frombuffer(
                        'RGBA', (width, height), raw_data, 'raw', 'BGRA', bpr, 1)
                else:
                    try:
                        coord_left, coord_top, right, bottom = win32gui.GetWindowRect(
                            self.window_handle)
                        coord_width = right - coord_left
                        coord_height = bottom - coord_top

                        hwnd_dc = win32gui.GetWindowDC(self.window_handle)
                        mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
                        save_dc = mfc_dc.CreateCompatibleDC()

                        save_bitmap = win32ui.CreateBitmap()
                        save_bitmap.CreateCompatibleBitmap(
                            mfc_dc, coord_width, coord_height)
                        save_dc.SelectObject(save_bitmap)

                        result = ctypes.windll.user32.PrintWindow(
                            self.window_handle, save_dc.GetSafeHdc(), 2)

                        bmpinfo = save_bitmap.GetInfo()
                        bmpstr = save_bitmap.GetBitmapBits(True)
                    except pywintypes.error:
                        return 0
                    img = Image.frombuffer('RGB', (bmpinfo['bmWidth'], bmpinfo['bmHeight']), bmpstr, 'raw', 'BGRX', 0,
                                           1)
                    try:
                        win32gui.DeleteObject(save_bitmap.GetHandle())
                    except:
                        pass
                    try:
                        save_dc.DeleteDC()
                    except:
                        pass
                    try:
                        mfc_dc.DeleteDC()
                    except:
                        pass
                    try:
                        win32gui.ReleaseDC(self.window_handle, hwnd_dc)
                    except:
                        pass
            else:
                sct_img = sct.grab(self.sct_params)
                img = Image.frombytes(
                    'RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')

            if not img.getbbox():
                logger.info(
                    "Screen Capture Didn't get Capturing anything, sleeping.")
                time.sleep(1)
                continue

            import random  # Ensure this is imported at the top of the file if not already
            # Executes only once out of 10 times
            rand_int = random.randint(1, 20)

            if rand_int == 1:  # Executes only once out of 10 times
                img.save(os.path.join(get_temporary_directory(),
                         'before_crop.png'), 'PNG')

            img = apply_ocr_config_to_image(img, self.ocr_config)

            if rand_int == 1:
                img.save(os.path.join(
                    get_temporary_directory(), 'after_crop.png'), 'PNG')

            if last_image and are_images_identical(img, last_image):
                logger.debug(
                    "Captured screenshot is identical to the last one, sleeping.")
                time.sleep(max(.5, get_ocr_scan_rate()))
            else:
                self.write_result(img)
                screenshot_event.clear()

        if self.macos_window_tracker_instance:
            self.macos_window_tracker_instance.join()
        elif self.windows_window_tracker_instance:
            self.windows_window_tracker_instance.join()


    
def apply_adaptive_threshold_filter(img):
    img = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    inverted = cv2.bitwise_not(gray)
    blur = cv2.GaussianBlur(inverted, (3, 3), 0)
    thresh = cv2.adaptiveThreshold(
        blur, 255, 
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
        cv2.THRESH_BINARY, 
        11, 2
    )
    result = cv2.bitwise_not(thresh)

    return Image.fromarray(result)


def set_last_image(image):
    global last_image, last_image_np
    if image is None:
        last_image = None
        last_image_np = None
    try:
        if image == last_image:
            return
    except Exception:
        last_image = None
        return
    try:
        if last_image is not None and hasattr(last_image, "close"):
            last_image.close()
    except Exception:
        pass
    last_image = image
    last_image_np = np.array(last_image)
    # last_image = apply_adaptive_threshold_filter(image)


def are_images_identical(img1, img2, img2_np=None):
    """
    Compares two images for pixel-wise identity.
    Optionally, pass a cached np.array for img2 as img2_np to avoid repeated conversion.

    Args:
        img1: PIL.Image or np.ndarray
        img2: PIL.Image or np.ndarray
        img2_np: Optional cached np.ndarray for img2

    Returns:
        bool: True if images are identical, False otherwise.
    """
    if any(v is None for v in (img1, img2, img2_np)):
        return False

    try:
        img1_np = np.array(img1)
        img2_np = img2_np if img2_np is not None else np.array(img2)
    except Exception:
        logger.warning("Failed to convert images to numpy arrays for comparison.")
        return False

    return (img1_np.shape == img2_np.shape) and np.array_equal(img1_np, img2_np)


ImageType = Union[np.ndarray, Image.Image]

def _prepare_image(image: ImageType) -> np.ndarray:
    """
    Standardizes an image (PIL or NumPy) into an OpenCV-compatible NumPy array (BGR).
    """
    # If the image is a PIL Image, convert it to a NumPy array
    if isinstance(image, Image.Image):
        # Convert PIL Image (which is RGB) to a NumPy array, then convert RGB to BGR for OpenCV
        prepared_image = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    # If it's already a NumPy array, assume it's in a compatible format (like BGR)
    elif isinstance(image, np.ndarray):
        prepared_image = image
    else:
        raise TypeError(f"Unsupported image type: {type(image)}. Must be a PIL Image or NumPy array.")

    return prepared_image

i = 1

def calculate_ssim_score(imageA: ImageType, imageB: ImageType) -> float:
    global i
    """
    Calculates the structural similarity index (SSIM) between two images.

    Args:
        imageA: The first image as a NumPy array.
        imageB: The second image as a NumPy array.

    Returns:
        The SSIM score between the two images (between -1 and 1).
    """
    
    if isinstance(imageA, Image.Image):
        imageA = apply_adaptive_threshold_filter(imageA)
        
    # Save Images to temp for debugging on a random 1/20 chance
    # if np.random.rand() < 0.05:
    # if i < 600:
    #     # Save as image_000
    #     imageA.save(os.path.join(get_temporary_directory(), f'frame_{i:03d}.png'), 'PNG')
    #     i += 1
        # imageB.save(os.path.join(get_temporary_directory(), f'ssim_imageB_{i:03d}.png'), 'PNG')

    imageA = _prepare_image(imageA)
    imageB = _prepare_image(imageB)

    # Images must have the same dimensions
    if imageA.shape != imageB.shape:
        raise ValueError("Input images must have the same dimensions.")

    # Convert images to grayscale for a more robust SSIM comparison
    # This is less sensitive to minor color changes and lighting.
    # grayA = cv2.cvtColor(imageA, cv2.COLOR_BGR2GRAY)
    # grayB = cv2.cvtColor(imageB, cv2.COLOR_BGR2GRAY)

    # Calculate the SSIM. The `score` is the main value.
    # The `win_size` parameter must be an odd number and less than the image dimensions.
    # We choose a value that is likely to be safe for a variety of image sizes.
    win_size = min(3, imageA.shape[0] // 2, imageA.shape[1] // 2)
    if win_size % 2 == 0:
        win_size -= 1 # ensure it's odd

    score, _ = ssim(imageA, imageB, full=True, win_size=win_size)

    return score



def are_images_similar(imageA: Image.Image, imageB: Image.Image, threshold: float = 0.98) -> bool:
    """
    Compares two images and returns True if their similarity score is above a threshold.

    Args:
        imageA: The first image as a NumPy array.
        imageB: The second image as a NumPy array.
        threshold: The minimum SSIM score to be considered "similar".
                   Defaults to 0.98 (very high similarity). Your original `90` would
                   be equivalent to a threshold of `0.90` here.

    Returns:
        True if the images are similar, False otherwise.
    """
    if None in (imageA, imageB):
        logger.info("One of the images is None, cannot compare.")
        return False
    try:
        score = calculate_ssim_score(imageA, imageB)
    except Exception as e:
        logger.info(e)
        return False
    return score > threshold


def quick_text_detection(pil_image, threshold_ratio=0.01):
    """
    Quick check if image likely contains text using edge detection.
    
    Args:
        pil_image (PIL.Image): Input image
        threshold_ratio (float): Minimum ratio of edge pixels to consider text present
    
    Returns:
        bool: True if text is likely present
    """
    # Convert to grayscale
    gray = np.array(pil_image.convert('L'))
    
    # Apply Canny edge detection
    edges = cv2.Canny(gray, 50, 150)
    
    # Calculate ratio of edge pixels
    edge_ratio = np.sum(edges > 0) / edges.size
    
    return edge_ratio > threshold_ratio


# Use OBS for Screenshot Source (i.e. Linux)
class OBSScreenshotThread(threading.Thread):
    def __init__(self, ocr_config, screen_capture_on_combo, width=1280, height=720, interval=1, is_manual_ocr=False):
        super().__init__(daemon=True)
        self.ocr_config = ocr_config
        self.interval = interval
        self.websocket = None
        self.current_source = None
        self.current_source_name = None
        self.current_scene = None
        self.width = width
        self.height = height
        self.use_periodic_queue = not screen_capture_on_combo
        self.is_manual_ocr = is_manual_ocr

    def write_result(self, result):
        if self.use_periodic_queue:
            periodic_screenshot_queue.put(result)
        else:
            image_queue.put((result, True))
        screenshot_event.clear()

    def connect_obs(self):
        import GameSentenceMiner.obs as obs
        obs.connect_to_obs_sync(check_output=False)
        
    def init_config(self, source=None, scene=None):
        import GameSentenceMiner.obs as obs
        obs.update_current_game()
        self.current_source = source if source else obs.get_active_source()
        logger.debug(f"Current OBS source: {self.current_source}")
        self.source_width = self.current_source.get(
            "sceneItemTransform").get("sourceWidth") or self.width
        self.source_height = self.current_source.get(
            "sceneItemTransform").get("sourceHeight") or self.height
        if self.source_width and self.source_height and not self.is_manual_ocr and get_ocr_two_pass_ocr():
            self.width, self.height = scale_down_width_height(
                self.source_width, self.source_height)
            logger.info(
                f"Using OBS source dimensions: {self.width}x{self.height}")
        else:
            self.width = self.source_width or 1280
            self.height = self.source_height or 720
            logger.info(
                f"Using source dimensions: {self.width}x{self.height}")
        self.current_source_name = self.current_source.get(
            "sourceName") or None
        self.current_scene = scene if scene else obs.get_current_game()
        self.ocr_config = get_scene_ocr_config(refresh=True)
        if not self.ocr_config:
            logger.error("No OCR config found for the current scene.")
            return
        self.ocr_config.scale_to_custom_size(self.width, self.height)

    def run(self):
        global last_image
        from PIL import Image
        import GameSentenceMiner.obs as obs

        # Register a scene switch callback in obsws
        def on_scene_switch(scene):
            logger.info(f"Scene switched to: {scene}. Loading new OCR config.")
            self.init_config(scene=scene)

        asyncio.run(obs.register_scene_change_callback(on_scene_switch))

        self.connect_obs()
        self.init_config()
        while not terminated:
            if not screenshot_event.wait(timeout=0.1):
                continue

            if not self.ocr_config:
                logger.info(
                    "No OCR config found for the current scene. Waiting for scene switch.")
                time.sleep(1)
                continue

            if not self.current_source_name:
                obs.update_current_game()
                self.current_source = obs.get_active_source()
                self.current_source_name = self.current_source.get(
                    "sourceName") or None

            try:
                if not self.current_source_name:
                    logger.error(
                        "No active source found in the current scene.")
                    self.write_result(1)
                    continue
                img = obs.get_screenshot_PIL(source_name=self.current_source_name,
                                             width=self.width, height=self.height, img_format='jpg', compression=100)
                
                img = apply_ocr_config_to_image(img, self.ocr_config)

                if img is not None:
                    self.write_result(img)
                else:
                    logger.error("Failed to get screenshot data from OBS.")

            except Exception as e:
                print(e)
                logger.info(
                    f"An unexpected error occurred during OBS Capture : {e}", exc_info=True)
                time.sleep(.5)
                continue
            
def scale_down_width_height(width, height):
        if width == 0 or height == 0:
            return width, height
        # return width, height
        aspect_ratio = width / height
        logger.info(
            f"Scaling down OBS source dimensions: {width}x{height} (Aspect Ratio: {aspect_ratio})")
        if aspect_ratio > 2.66:
            logger.info("Using ultra-wide aspect ratio scaling (32:9).")
            return 1920, 540
        elif aspect_ratio > 2.33:
            logger.info("Using ultra-wide aspect ratio scaling (21:9).")
            return 1920, 800
        elif aspect_ratio > 1.77:
            logger.info("Using standard aspect ratio scaling (16:9).")
            return 1280, 720
        elif aspect_ratio > 1.6:
            logger.info("Using standard aspect ratio scaling (16:10).")
            return 1280, 800
        elif aspect_ratio > 1.33:
            logger.info("Using standard aspect ratio scaling (4:3).")
            return 960, 720
        elif aspect_ratio > 1.25:
            logger.info("Using standard aspect ratio scaling (5:4).")
            return 900, 720
        elif aspect_ratio > 1.5:
            logger.info("Using standard aspect ratio scaling (3:2).")
            return 1080, 720
        else:
            logger.info(
                "Using default aspect ratio scaling (original resolution).")
            return width, height


def apply_ocr_config_to_image(img, ocr_config, is_secondary=False, rectangles=None):
    for rectangle in ocr_config.rectangles:
        if rectangle.is_excluded:
            left, top, width, height = rectangle.coordinates
            draw = ImageDraw.Draw(img)
            draw.rectangle((left, top, left + width, top + height), fill=(0, 0, 0, 0))
            
    if not rectangles:   
        rectangles = [r for r in ocr_config.rectangles if not r.is_excluded and r.is_secondary == is_secondary]
    
    # Sort top to bottom
    if rectangles:
        rectangles.sort(key=lambda r: r.coordinates[1])

    cropped_sections = []
    for rectangle in rectangles:
        area = rectangle.coordinates
        # Ensure crop coordinates are within image bounds
        left = max(0, area[0])
        top = max(0, area[1])
        right = min(img.width, area[0] + area[2])
        bottom = min(img.height, area[1] + area[3])
        crop = img.crop((left, top, right, bottom))
        cropped_sections.append(crop)

    if len(cropped_sections) > 1:
        # Width is the max width of all sections, height is the sum of all sections + gaps
        # Gaps are 50 pixels between sections
        combined_width = max(section.width for section in cropped_sections)
        combined_height = sum(section.height for section in cropped_sections) + (
            len(cropped_sections) - 1) * 50
        combined_img = Image.new("RGBA", (combined_width, combined_height))
        y_offset = 0
        for section in cropped_sections:
            combined_img.paste(section, (0, y_offset))
            y_offset += section.height + 50
        img = combined_img
    elif cropped_sections:
        img = cropped_sections[0]
    return img


class AutopauseTimer:
    def __init__(self, timeout):
        self.stop_event = threading.Event()
        self.timeout = timeout
        self.timer_thread = None

    def __del__(self):
        self.stop()

    def start(self):
        self.stop()
        self.stop_event.clear()
        self.timer_thread = threading.Thread(target=self._countdown)
        self.timer_thread.start()

    def stop(self):
        if not self.stop_event.is_set() and self.timer_thread and self.timer_thread.is_alive():
            self.stop_event.set()
            self.timer_thread.join()

    def _countdown(self):
        seconds = self.timeout
        while seconds > 0 and not self.stop_event.is_set() and not terminated:
            time.sleep(1)
            seconds -= 1
        if not self.stop_event.is_set():
            self.stop_event.set()
            if not (paused or terminated):
                pause_handler(True)


def pause_handler(is_combo=True):
    global paused
    message = 'Unpaused!' if paused else 'Paused!'

    if auto_pause_handler:
        auto_pause_handler.stop()
    if is_combo:
        notifier.send(title='owocr', message=message)
    logger.info(message)
    paused = not paused


def engine_change_handler(user_input='s', is_combo=True):
    global engine_index
    old_engine_index = engine_index

    if user_input.lower() == 's':
        if engine_index == len(engine_keys) - 1:
            engine_index = 0
        else:
            engine_index += 1
    elif user_input.lower() != '' and user_input.lower() in engine_keys:
        engine_index = engine_keys.index(user_input.lower())
    if engine_index != old_engine_index:
        new_engine_name = engine_instances[engine_index].readable_name
        if is_combo:
            notifier.send(
                title='owocr', message=f'Switched to {new_engine_name}')
        engine_color = config.get_general('engine_color')
        logger.opt(ansi=True).info(
            f'Switched to <{engine_color}>{new_engine_name}</{engine_color}>!')


def engine_change_handler_name(engine):
    global engine_index
    old_engine_index = engine_index

    for i, instance in enumerate(engine_instances):
        if instance.name.lower() in engine.lower():
            engine_index = i
            break

    if engine_index != old_engine_index:
        new_engine_name = engine_instances[engine_index].readable_name
        notifier.send(title='owocr', message=f'Switched to {new_engine_name}')
        engine_color = config.get_general('engine_color')
        logger.opt(ansi=True).info(
            f'Switched to <{engine_color}>{new_engine_name}</{engine_color}>!')


def user_input_thread_run():
    def _terminate_handler():
        global terminated
        logger.info('Terminated!')
        terminated = True
    import sys

    if sys.platform == 'win32':
        import msvcrt
        while not terminated:
            user_input = None
            if msvcrt.kbhit():  # Check if a key is pressed
                user_input_bytes = msvcrt.getch()
                try:
                    user_input = user_input_bytes.decode()
                except UnicodeDecodeError:
                    pass
            if not user_input:  # If no input from msvcrt, check stdin
                import sys
                user_input = sys.stdin.read(1)

                if user_input.lower() in 'tq':
                    _terminate_handler()
                elif user_input.lower() == 'p':
                    pause_handler(False)
                else:
                    engine_change_handler(user_input, False)
    else:
        import tty
        import termios
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        try:
            tty.setcbreak(sys.stdin.fileno())
            while not terminated:
                user_input = sys.stdin.read(1)
                if user_input.lower() in 'tq':
                    _terminate_handler()
                elif user_input.lower() == 'p':
                    pause_handler(False)
                else:
                    engine_change_handler(user_input, False)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def signal_handler(sig, frame):
    global terminated
    logger.info('Terminated!')
    terminated = True


def on_window_closed(alive):
    global terminated
    if not (alive or terminated):
        logger.info('Window closed or error occurred, terminated!')
        terminated = True


def on_screenshot_combo():
    if not paused:
        screenshot_event.set()


def on_window_minimized(minimized):
    global screencapture_window_visible
    screencapture_window_visible = not minimized
    

def do_configured_ocr_replacements(text: str) -> str:
    return do_text_replacements(text, OCR_REPLACEMENTS_FILE)


def process_and_write_results(img_or_path, write_to=None, last_result=None, filtering: TextFiltering = None, notify=None, engine=None, ocr_start_time=None, furigana_filter_sensitivity=0):
    global engine_index
    # TODO Replace this at a later date
    is_second_ocr = bool(engine)
    if auto_pause_handler:
        auto_pause_handler.stop()
    if engine:
        for i, instance in enumerate(engine_instances):
            if instance.name.lower() in engine.lower():
                engine_instance = instance
                break
    else:
        engine_instance = engine_instances[engine_index]
        engine = engine_instance.name

    engine_color = config.get_general('engine_color')
    
    start_time = time.time()
    result = engine_instance(img_or_path, furigana_filter_sensitivity)
    res, text, crop_coords = (*result, None)[:3]

    if not res and ocr_2 == engine:
        logger.opt(ansi=True).info(
            f"<{engine_color}>{engine_instance.readable_name}</{engine_color}> failed with message: {text}, trying <{engine_color}>{ocr_1}</{engine_color}>")
        for i, instance in enumerate(engine_instances):
            if instance.name.lower() in ocr_1.lower():
                engine_instance = instance
                if last_result:
                    last_result = []
                break
        start_time = time.time()
        result = engine_instance(img_or_path, furigana_filter_sensitivity)
        res, text, crop_coords = (*result, None)[:3]

    end_time = time.time()

    orig_text = []
    # print(filtering)
    #
    #
    # print(lang)

    # print(last_result)
    # print(engine_index)

    if res:
        if 'provider' in text:
            if write_to == 'callback':
                logger.opt(ansi=True).info(f"{len(text['boxes'])} text boxes recognized using Meiki:")
                txt_callback('', '', ocr_start_time,
                             img_or_path, is_second_ocr, filtering, text.get('crop_coords', None), meiki_boxes=text.get('boxes', []))
                return str(text), str(text)
        
        if isinstance(text, list):
            for i, line in enumerate(text):
                text[i] = do_configured_ocr_replacements(line)
        else:
            text = do_configured_ocr_replacements(text)
        if filtering:
            text, orig_text = filtering(text, last_result, engine=engine, is_second_ocr=is_second_ocr)
        if get_ocr_language() == "ja" or get_ocr_language() == "zh":
            text = post_process(text, keep_blank_lines=get_ocr_keep_newline())
        if notify and config.get_general('notifications'):
            notifier.send(title='owocr', message='Text recognized: ' + text)
            
        if text and write_to is not None:
            if check_text_is_all_menu(text, crop_coords):
                logger.opt(ansi=True).info('Text is identified as all menu items, skipping further processing.')
                return orig_text, ''
            
        logger.opt(ansi=True).info(
    f'Text recognized in {end_time - start_time:0.03f}s using <{engine_color}>{engine_instance.readable_name}</{engine_color}>: {text}')

        if write_to == 'websocket':
            websocket_server_thread.send_text(text)
        elif write_to == 'clipboard':
            pyperclipfix.copy(text)
        elif write_to == "callback":
            txt_callback(text, orig_text, ocr_start_time,
                         img_or_path, is_second_ocr, filtering, crop_coords)
        elif write_to:
            with Path(write_to).open('a', encoding='utf-8') as f:
                f.write(text + '\n')

        if auto_pause_handler and not paused:
            auto_pause_handler.start()
    else:
        logger.opt(ansi=True).info(
            f'<{engine_color}>{engine_instance.readable_name}</{engine_color}> reported an error after {end_time - start_time:0.03f}s: {text}')

    # print(orig_text)
    # print(text)

    return orig_text, text

def check_text_is_all_menu(text: str, crop_coords: tuple) -> bool:
    """
    Checks if the recognized text consists entirely of menu items.
    This function checks if the detected text area falls entirely within secondary rectangles (menu areas).

    :param text: The recognized text from OCR.
    :param crop_coords: Tuple containing (x, y, x2, y2) of the detected text area relative to the cropped image.
    :return: True if the text is all menu items (within secondary rectangles), False otherwise.
    """
    if not text or not crop_coords:
        return False

    original_width = obs_screenshot_thread.width
    original_height = obs_screenshot_thread.height
    crop_x, crop_y, crop_x2, crop_y2 = crop_coords

    ocr_config = get_scene_ocr_config()
    
    if not any(rect.is_secondary for rect in ocr_config.rectangles):
        return False

    ocr_config.scale_to_custom_size(original_width, original_height)
    if not ocr_config or not ocr_config.rectangles:
        return False

    primary_rectangles = [rect for rect in ocr_config.rectangles if not rect.is_excluded and not rect.is_secondary]
    menu_rectangles = [rect for rect in ocr_config.rectangles if rect.is_secondary and not rect.is_excluded]

    if not menu_rectangles:
        return False

    if not primary_rectangles:
        if crop_x < 0 or crop_y < 0 or crop_x2 > original_width or crop_y2 > original_height:
            return False
        for menu_rect in menu_rectangles:
            rect_left, rect_top, rect_width, rect_height = menu_rect.coordinates
            rect_right = rect_left + rect_width
            rect_bottom = rect_top + rect_height
            if (crop_x >= rect_left and crop_y >= rect_top and
                crop_x2 <= rect_right and crop_y2 <= rect_bottom):
                return True
        return False

    primary_rectangles.sort(key=lambda r: r.coordinates[1])

    if len(primary_rectangles) == 1:
        primary_rect = primary_rectangles[0]
        primary_left, primary_top, primary_width, primary_height = primary_rect.coordinates
        original_x = crop_x + primary_left
        original_y = crop_y + primary_top
        original_x2 = crop_x2 + primary_left
        original_y2 = crop_y2 + primary_top
    else:
        current_y_offset = 0
        original_x = None
        original_y = None
        original_x2 = None
        original_y2 = None
        for i, primary_rect in enumerate(primary_rectangles):
            primary_left, primary_top, primary_width, primary_height = primary_rect.coordinates
            section_height = primary_height
            if crop_y >= current_y_offset and crop_y < current_y_offset + section_height:
                original_x = crop_x + primary_left
                original_y = (crop_y - current_y_offset) + primary_top
                original_x2 = crop_x2 + primary_left
                original_y2 = crop_y2 + primary_top
                break
            current_y_offset += section_height + 50
        if original_x is None or original_y is None:
            return False

    if original_x < 0 or original_y < 0 or original_x > original_width or original_y > original_height:
        return False

    for menu_rect in menu_rectangles:
        rect_left, rect_top, rect_width, rect_height = menu_rect.coordinates
        rect_right = rect_left + rect_width
        rect_bottom = rect_top + rect_height
        if (original_x >= rect_left and original_y >= rect_top and
            original_x2 <= rect_right and original_y2 <= rect_bottom):
            return True

    return False

def get_path_key(path):
    return path, path.lstat().st_mtime


def init_config(parse_args=True):
    global config
    config = Config(parse_args)


def run(read_from=None,
        read_from_secondary=None,
        write_to=None,
        engine=None,
        pause_at_startup=None,
        ignore_flag=None,
        delete_images=None,
        notifications=None,
        auto_pause=0,
        combo_pause=None,
        combo_engine_switch=None,
        screen_capture_area=None,
        screen_capture_areas=None,
        screen_capture_exclusions=None,
        screen_capture_window=None,
        screen_capture_delay_secs=None,
        screen_capture_combo=None,
        stop_running_flag=None,
        screen_capture_event_bus=None,
        text_callback=None,
        monitor_index=None,
        ocr1=None,
        ocr2=None,
        gsm_ocr_config=None,
        furigana_filter_sensitivity=None,
        config_check_thread=None
        ):
    """
    Japanese OCR client

    Runs OCR in the background.
    It can read images copied to the system clipboard or placed in a directory, images sent via a websocket or a Unix domain socket, or directly capture a screen (or a portion of it) or a window.
    Recognized texts can be either saved to system clipboard, appended to a text file or sent via a websocket.

    :param read_from: Specifies where to read input images from. Can be either "clipboard", "websocket", "unixsocket" (on macOS/Linux), "screencapture", or a path to a directory.
    :param write_to: Specifies where to save recognized texts to. Can be either "clipboard", "websocket", or a path to a text file.
    :param delay_secs: How often to check for new images, in seconds.
    :param engine: OCR engine to use. Available: "mangaocr", "glens", "glensweb", "bing", "gvision", "avision", "alivetext", "azure", "winrtocr", "oneocr", "easyocr", "rapidocr", "ocrspace".
    :param pause_at_startup: Pause at startup.
    :param ignore_flag: Process flagged clipboard images (images that are copied to the clipboard with the *ocr_ignore* string).
    :param delete_images: Delete image files after processing when reading from a directory.
    :param notifications: Show an operating system notification with the detected text.
    :param auto_pause: Automatically pause the program after the specified amount of seconds since the last successful text recognition. Will be ignored when reading with screen capture. 0 to disable.
    :param combo_pause: Specifies a combo to wait on for pausing the program. As an example: "<ctrl>+<shift>+p". The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key
    :param combo_engine_switch: Specifies a combo to wait on for switching the OCR engine. As an example: "<ctrl>+<shift>+a". To be used with combo_pause. The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key
    :param screen_capture_area: Specifies area to target when reading with screen capture. Can be either empty (automatic selector), a set of coordinates (x,y,width,height), "screen_N" (captures a whole screen, where N is the screen number starting from 1) or a window name (the first matching window title will be used).
    :param screen_capture_delay_secs: Specifies the delay (in seconds) between screenshots when reading with screen capture.
    :param screen_capture_only_active_windows: When reading with screen capture and screen_capture_area is a window name, specifies whether to only target the window while it's active.
    :param screen_capture_combo: When reading with screen capture, specifies a combo to wait on for taking a screenshot instead of using the delay. As an example: "<ctrl>+<shift>+s". The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key
    """

    if read_from is None:
        read_from = config.get_general('read_from')

    if read_from_secondary is None:
        read_from_secondary = config.get_general('read_from_secondary')

    if screen_capture_area is None:
        screen_capture_area = config.get_general('screen_capture_area')

    # if screen_capture_only_active_windows is None:
    #     screen_capture_only_active_windows = config.get_general('screen_capture_only_active_windows')

    if screen_capture_exclusions is None:
        screen_capture_exclusions = config.get_general(
            'screen_capture_exclusions')

    if screen_capture_window is None:
        screen_capture_window = config.get_general('screen_capture_window')

    if screen_capture_delay_secs is None:
        screen_capture_delay_secs = config.get_general(
            'screen_capture_delay_secs')

    if screen_capture_combo is None:
        screen_capture_combo = config.get_general('screen_capture_combo')

    if stop_running_flag is None:
        stop_running_flag = config.get_general('stop_running_flag')

    if screen_capture_event_bus is None:
        screen_capture_event_bus = config.get_general(
            'screen_capture_event_bus')

    if text_callback is None:
        text_callback = config.get_general('text_callback')

    if write_to is None:
        write_to = config.get_general('write_to')

    logger.configure(
        handlers=[{'sink': sys.stderr, 'format': config.get_general('logger_format')}])

    if config.has_config:
        logger.info('Parsed config file')
    else:
        logger.warning('No config file, defaults will be used.')
        if config.downloaded_config:
            logger.info(
                f'A default config file has been downloaded to {config.config_path}')

    global engine_instances
    global engine_keys
    engine_instances = []
    config_engines = []
    engine_keys = []
    default_engine = ''

    if len(config.get_general('engines')) > 0:
        for config_engine in config.get_general('engines').split(','):
            config_engines.append(config_engine.strip().lower())

    for _, engine_class in sorted(inspect.getmembers(sys.modules[__name__],
                                                     lambda x: hasattr(x, '__module__') and x.__module__ and (
        __package__ + '.ocr' in x.__module__ or __package__ + '.secret' in x.__module__) and inspect.isclass(
                                                         x))):
        if len(config_engines) == 0 or engine_class.name in config_engines:
            if config.get_engine(engine_class.name) == None:
                engine_instance = engine_class()
            else:
                engine_instance = engine_class(config.get_engine(
                    engine_class.name), lang=get_ocr_language())

            if engine_instance.available:
                engine_instances.append(engine_instance)
                engine_keys.append(engine_class.key)
                if engine == engine_class.name:
                    default_engine = engine_class.key

    if len(engine_keys) == 0:
        msg = 'No engines available!'
        raise NotImplementedError(msg)

    global engine_index
    global terminated
    global paused
    global just_unpaused
    global first_pressed
    global auto_pause_handler
    global notifier
    global websocket_server_thread
    global screenshot_thread
    global obs_screenshot_thread
    global image_queue
    global ocr_1
    global ocr_2
    ocr_1 = ocr1
    ocr_2 = ocr2
    custom_left = None
    terminated = False
    paused = pause_at_startup
    just_unpaused = True
    first_pressed = None
    auto_pause_handler = None
    engine_index = engine_keys.index(
        default_engine) if default_engine != '' else 0
    engine_color = config.get_general('engine_color')
    prefix_to_use = ""
    delay_secs = config.get_general('delay_secs')

    non_path_inputs = ('screencapture', 'clipboard',
                       'websocket', 'unixsocket', 'obs')
    read_from_path = None
    read_from_readable = []
    terminated = False
    paused = config.get_general('pause_at_startup')
    auto_pause = config.get_general('auto_pause')
    clipboard_thread = None
    websocket_server_thread = None
    screenshot_thread = None
    directory_watcher_thread = None
    unix_socket_server = None
    key_combo_listener = None
    filtering = None
    auto_pause_handler = None
    engine_index = engine_keys.index(
        default_engine) if default_engine != '' else 0
    engine_color = config.get_general('engine_color')
    combo_pause = config.get_general('combo_pause')
    combo_engine_switch = config.get_general('combo_engine_switch')
    screen_capture_on_combo = False
    notifier = DesktopNotifierSync()
    image_queue = queue.Queue()
    key_combos = {}

    if combo_pause != '':
        key_combos[combo_pause] = pause_handler
    if combo_engine_switch:
        if combo_pause:
            key_combos[combo_engine_switch] = engine_change_handler
        else:
            raise ValueError('combo_pause must also be specified')

    if 'websocket' in (read_from, read_from_secondary) or write_to == 'websocket':
        websocket_server_thread = WebsocketServerThread(
            'websocket' in (read_from, read_from_secondary))
        websocket_server_thread.start()

    if write_to == "callback" and text_callback:
        global txt_callback
        txt_callback = text_callback

    if any(x in ('screencapture', 'obs') for x in (read_from, read_from_secondary)):
        global screenshot_event
        global take_screenshot
        if screen_capture_combo != '':
            screen_capture_on_combo = True
            key_combos[screen_capture_combo] = on_screenshot_combo
        else:
            global periodic_screenshot_queue
            periodic_screenshot_queue = queue.Queue()

    if 'screencapture' in (read_from, read_from_secondary):
        last_screenshot_time = 0
        last_result = ([], engine_index)

        screenshot_event = threading.Event()
        screenshot_thread = ScreenshotThread(screen_capture_area, screen_capture_window,
                                                gsm_ocr_config, screen_capture_on_combo)
        screenshot_thread.start()
        filtering = TextFiltering()
        read_from_readable.append('screen capture')
    if 'obs' in (read_from, read_from_secondary):
        last_screenshot_time = 0
        last_result = ([], engine_index)
        screenshot_event = threading.Event()
        obs_screenshot_thread = OBSScreenshotThread(
            gsm_ocr_config, screen_capture_on_combo, interval=screen_capture_delay_secs, is_manual_ocr=bool(screen_capture_on_combo))
        obs_screenshot_thread.start()
        filtering = TextFiltering()
        read_from_readable.append('obs')
    if 'websocket' in (read_from, read_from_secondary):
        read_from_readable.append('websocket')
    if 'unixsocket' in (read_from, read_from_secondary):
        if sys.platform == 'win32':
            raise ValueError(
                '"unixsocket" is not currently supported on Windows')
        socket_path = Path('/tmp/owocr.sock')
        if socket_path.exists():
            socket_path.unlink()
        unix_socket_server = socketserver.ThreadingUnixStreamServer(
            str(socket_path), RequestHandler)
        unix_socket_server_thread = threading.Thread(
            target=unix_socket_server.serve_forever, daemon=True)
        unix_socket_server_thread.start()
        read_from_readable.append('unix socket')
    if 'clipboard' in (read_from, read_from_secondary):
        clipboard_thread = ClipboardThread()
        clipboard_thread.start()
        read_from_readable.append('clipboard')
    if any(i and i not in non_path_inputs for i in (read_from, read_from_secondary)):
        if all(i and i not in non_path_inputs for i in (read_from, read_from_secondary)):
            raise ValueError(
                "read_from and read_from_secondary can't both be directory paths")
        delete_images = config.get_general('delete_images')
        read_from_path = Path(read_from) if read_from not in non_path_inputs else Path(
            read_from_secondary)
        if not read_from_path.is_dir():
            raise ValueError(
                'read_from and read_from_secondary must be either "websocket", "unixsocket", "clipboard", "screencapture", or a path to a directory')
        directory_watcher_thread = DirectoryWatcher(read_from_path)
        directory_watcher_thread.start()
        read_from_readable.append(f'directory {read_from_path}')

    if len(key_combos) > 0:
        try:
            from pynput import keyboard
            key_combo_listener = keyboard.GlobalHotKeys(key_combos)
            key_combo_listener.start()
        except ImportError:
            pass

    if write_to in ('clipboard', 'websocket', 'callback'):
        write_to_readable = write_to
    else:
        if Path(write_to).suffix.lower() != '.txt':
            raise ValueError(
                'write_to must be either "websocket", "clipboard" or a path to a text file')
        write_to_readable = f'file {write_to}'

    process_queue = (any(i in ('clipboard', 'websocket', 'unixsocket') for i in (
        read_from, read_from_secondary)) or read_from_path or screen_capture_on_combo)
    process_screenshots = any(x in ('screencapture', 'obs') for x in (
        read_from, read_from_secondary)) and not screen_capture_on_combo
    if threading.current_thread() == threading.main_thread():
        signal.signal(signal.SIGINT, signal_handler)
    if (not process_screenshots) and auto_pause != 0:
        auto_pause_handler = AutopauseTimer(auto_pause)
    user_input_thread = threading.Thread(
        target=user_input_thread_run, daemon=True)
    user_input_thread.start()
    logger.opt(ansi=True).info(
        f"Reading from {' and '.join(read_from_readable)}, writing to {write_to_readable} using <{engine_color}>{engine_instances[engine_index].readable_name}</{engine_color}>{' (paused)' if paused else ''}")
    if screen_capture_combo:
        logger.opt(ansi=True).info(
            f'Manual OCR Running... Press <{engine_color}>{screen_capture_combo.replace("<", "").replace(">", "")}</{engine_color}> to run OCR')

    def handle_config_changes(changes):
        nonlocal last_result
        if any(c in changes for c in ('ocr1', 'ocr2', 'language', 'furigana_filter_sensitivity')):
            last_result = ([], engine_index)
            engine_change_handler_name(get_ocr_ocr1())
            
    def handle_area_config_changes(changes):
        if screenshot_thread:
            screenshot_thread.ocr_config = get_scene_ocr_config()
        if obs_screenshot_thread:
            obs_screenshot_thread.init_config()
                
    config_check_thread.add_config_callback(handle_config_changes)
    config_check_thread.add_area_callback(handle_area_config_changes)
    previous_text = "Placeholder"
    sleep_time_to_add = 0
    last_result_time = time.time()
    while not terminated:
        ocr_start_time = datetime.now()
        start_time = time.time()
        img = None
        filter_img = False

        if process_queue:
            try:
                img, filter_img = image_queue.get(timeout=0.1)
                notify = True
            except queue.Empty:
                pass
            
        if get_ocr_scan_rate() < .5:
            adjusted_scan_rate = min(get_ocr_scan_rate() + sleep_time_to_add, .5)
        else:
            adjusted_scan_rate = get_ocr_scan_rate()
            
        if (not img) and process_screenshots:
            if (not paused) and (not screenshot_thread or (screenshot_thread.screencapture_window_active and screenshot_thread.screencapture_window_visible)) and (time.time() - last_screenshot_time) > adjusted_scan_rate:
                screenshot_event.set()
                img = periodic_screenshot_queue.get()
                filter_img = True
                notify = False
                last_screenshot_time = time.time()
                ocr_start_time = datetime.now()
                if adjusted_scan_rate > get_ocr_scan_rate():
                    ocr_start_time = ocr_start_time - timedelta(seconds=adjusted_scan_rate - get_ocr_scan_rate())

        if img == 0:
            on_window_closed(False)
            terminated = True
            break
        elif img:
            if filter_img:
                ocr_config = get_scene_ocr_config()
                # Check if the image is completely empty (all white or all black)
                try:
                    extrema = img.getextrema()
                    # For RGB or RGBA images, extrema is a tuple of (min, max) for each channel
                    if isinstance(extrema[0], tuple):
                        is_empty = all(e[0] == e[1] for e in extrema)
                    else:
                        is_empty = extrema[0] == extrema[1]
                    if is_empty:
                        logger.info("Image is totally empty (all pixels the same), sleeping.")
                        sleep_time_to_add = .5
                        continue
                except Exception as e:
                    logger.debug(f"Could not determine if image is empty: {e}")
                    
                # Compare images, but only if it's one box, multiple boxes skews results way too much and produces false positives
                # if ocr_config and len(ocr_config.rectangles) < 2:
                #     if are_images_similar(img, last_image):
                #         logger.info("Captured screenshot is similar to the last one, sleeping.")
                #         if time.time() - last_result_time > 10:
                #             sleep_time_to_add += .005
                #         continue
                # else:
                if are_images_identical(img, last_image, last_image_np):
                    logger.info("Captured screenshot is identical to the last one, sleeping.")
                    if time.time() - last_result_time > 10:
                        sleep_time_to_add += .005
                    continue

                res, text = process_and_write_results(img, write_to, last_result, filtering, notify,
                                                   ocr_start_time=ocr_start_time, furigana_filter_sensitivity=None if get_ocr_two_pass_ocr() else get_furigana_filter_sensitivity())
                if not text and not previous_text and time.time() - last_result_time > 10:
                    sleep_time_to_add += .005
                    logger.info(f"No text detected again, sleeping.")
                else:
                    sleep_time_to_add = 0
                    
                # If image was stabilized, and now there is no text, reset sleep time
                if not previous_text and not res:
                    sleep_time_to_add = 0
                previous_text = text
                if res:
                    last_result = (res, engine_index)
                    last_result_time = time.time()
            else:
                process_and_write_results(
                    img, write_to, None, notify=notify, ocr_start_time=ocr_start_time, engine=ocr2)
            if isinstance(img, Path):
                if delete_images:
                    Path.unlink(img)

        elapsed_time = time.time() - start_time
        if (not terminated) and elapsed_time < 0.1:
            time.sleep(0.1 - elapsed_time)

    if websocket_server_thread:
        websocket_server_thread.stop_server()
        websocket_server_thread.join()
    if clipboard_thread:
        if sys.platform == 'win32':
            win32api.PostThreadMessage(
                clipboard_thread.thread_id, win32con.WM_QUIT, 0, 0)
        clipboard_thread.join()
    if directory_watcher_thread:
        directory_watcher_thread.join()
    if unix_socket_server:
        unix_socket_server.shutdown()
        unix_socket_server.join()
    if screenshot_thread:
        screenshot_thread.join()
    if key_combo_listener:
        key_combo_listener.stop()
    if config_check_thread:
        config_check_thread.join()
