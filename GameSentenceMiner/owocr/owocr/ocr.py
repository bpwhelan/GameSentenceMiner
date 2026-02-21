
import base64
import ctypes
import curl_cffi
import importlib
import io
import json
import logging
import numpy as np
import os
import platform
import random
import re
import regex
import struct
import sys
import time
import warnings
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError
from dataclasses import dataclass, field, asdict
from math import sqrt, floor, sin, cos, atan2
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlparse, parse_qs, urlencode

from GameSentenceMiner.ocr import SharedMeikiOCRModel
from .screen_ai_downloader import ensure_screen_ai_resources
from GameSentenceMiner.util.config.electron_config import get_ocr_language, get_furigana_filter_sensitivity
from GameSentenceMiner.util.config.configuration import CommonLanguages, logger, get_config

# from GameSentenceMiner.util.config.configuration import get_temporary_directory

try:
    from manga_ocr import MangaOcr as MOCR
    from comic_text_detector.inference import TextDetector
    from scipy.signal.windows import gaussian
    import torch
    import cv2
except ImportError:
    pass

try:
    import Vision
    import objc
    from AppKit import NSData, NSImage, NSBundle
    from CoreFoundation import CFRunLoopRunInMode, kCFRunLoopDefaultMode, CFRunLoopStop, CFRunLoopGetCurrent
except ImportError:
    pass

try:
    from google.cloud import vision
    from google.oauth2 import service_account
    from google.api_core.exceptions import ServiceUnavailable
except ImportError:
    pass

try:
    from azure.ai.vision.imageanalysis import ImageAnalysisClient
    from azure.ai.vision.imageanalysis.models import VisualFeatures
    from azure.core.credentials import AzureKeyCredential
    from azure.core.exceptions import ServiceRequestError
except ImportError:
    pass

try:
    import easyocr
except ImportError:
    pass

try:
    from rapidocr_onnxruntime import RapidOCR as ROCR
    from rapidocr_onnxruntime import EngineType, LangDet, LangRec, ModelType, OCRVersion
    import urllib.request
except ImportError:
    pass

try:
    import winocr
except ImportError:
    pass

oneocr = None
_oneocr_dll_path = os.path.expanduser('~/.config/oneocr/oneocr.dll')
if os.path.exists(_oneocr_dll_path):
    try:
        import oneocr
    except SystemExit as e:
        # oneocr currently calls sys.exit() on DLL load failures; keep GSM alive and disable OneOCR instead.
        oneocr = None
        logger.warning(f'Failed to import OneOCR: {e}')
    except Exception as e:
        oneocr = None
        logger.warning(f'Failed to import OneOCR: {e}', exc_info=True)

try:
    import pyjson5
except ImportError:
    pass

LensOverlayServerRequestPb2 = None
LensOverlayServerResponsePb2 = None
PLATFORM_WEB = None
SURFACE_CHROMIUM = None
AUTO_FILTER = None
try:
    from GameSentenceMiner.owocr.owocr.lens_protos.lens_overlay_server_pb2 import (
        LensOverlayServerRequest as LensOverlayServerRequestPb2,
        LensOverlayServerResponse as LensOverlayServerResponsePb2,
    )
    from GameSentenceMiner.owocr.owocr.lens_protos.lens_overlay_platform_pb2 import PLATFORM_WEB
    from GameSentenceMiner.owocr.owocr.lens_protos.lens_overlay_surface_pb2 import SURFACE_CHROMIUM
    from GameSentenceMiner.owocr.owocr.lens_protos.lens_overlay_filters_pb2 import AUTO_FILTER
except Exception:
    previous = os.environ.get("TEMPORARILY_DISABLE_PROTOBUF_VERSION_CHECK")
    try:
        os.environ["TEMPORARILY_DISABLE_PROTOBUF_VERSION_CHECK"] = "true"
        from GameSentenceMiner.owocr.owocr.lens_protos.lens_overlay_server_pb2 import (
            LensOverlayServerRequest as LensOverlayServerRequestPb2,
            LensOverlayServerResponse as LensOverlayServerResponsePb2,
        )
        from GameSentenceMiner.owocr.owocr.lens_protos.lens_overlay_platform_pb2 import PLATFORM_WEB
        from GameSentenceMiner.owocr.owocr.lens_protos.lens_overlay_surface_pb2 import SURFACE_CHROMIUM
        from GameSentenceMiner.owocr.owocr.lens_protos.lens_overlay_filters_pb2 import AUTO_FILTER
    except Exception:
        pass
    finally:
        if previous is None:
            os.environ.pop("TEMPORARILY_DISABLE_PROTOBUF_VERSION_CHECK", None)
        else:
            os.environ["TEMPORARILY_DISABLE_PROTOBUF_VERSION_CHECK"] = previous

try:
    from google.protobuf.json_format import MessageToDict
except ImportError:
    MessageToDict = None

def _load_screen_ai_pb2():
    module_paths = (
        "GameSentenceMiner.owocr.owocr.screen_ai.proto.chrome_screen_ai_pb2",
        "GameSentenceMiner.owocr.owocr.screen_ai.chrome_screen_ai_pb2",
    )

    for module_path in module_paths:
        try:
            return importlib.import_module(module_path)
        except Exception:
            continue

    # Some protobuf runtime combinations require this temporary compatibility switch.
    previous = os.environ.get("TEMPORARILY_DISABLE_PROTOBUF_VERSION_CHECK")
    try:
        os.environ["TEMPORARILY_DISABLE_PROTOBUF_VERSION_CHECK"] = "true"
        for module_path in module_paths:
            try:
                return importlib.import_module(module_path)
            except Exception:
                continue
        return None
    finally:
        if previous is None:
            os.environ.pop("TEMPORARILY_DISABLE_PROTOBUF_VERSION_CHECK", None)
        else:
            os.environ["TEMPORARILY_DISABLE_PROTOBUF_VERSION_CHECK"] = previous


screen_ai_pb2 = _load_screen_ai_pb2()

try:
    import fpng_py
    optimized_png_encode = True
except:
    optimized_png_encode = False

manga_ocr_model = None

@dataclass
class BoundingBox:
    """
    Represents the normalized coordinates of a detected element.
    All values are floats between 0.0 and 1.0.
    """
    center_x: float
    center_y: float
    width: float
    height: float
    rotation_z: Optional[float] = None  # Optional rotation in radians

    @property
    def left(self) -> float:
        return self.center_x - self.width / 2

    @property
    def right(self) -> float:
        return self.center_x + self.width / 2

    @property
    def top(self) -> float:
        return self.center_y - self.height / 2

    @property
    def bottom(self) -> float:
        return self.center_y + self.height / 2

@dataclass
class Word:
    """Represents a single recognized word and its properties."""
    text: str
    bounding_box: BoundingBox
    separator: Optional[str] = None  # The character(s) that follow the word, e.g., a space

@dataclass
class Line:
    """Represents a single line of text, composed of words."""
    bounding_box: BoundingBox
    words: List[Word] = field(default_factory=list)
    text: Optional[str] = None # Optional: The entire text line, as reported by the OCR engine

@dataclass
class Paragraph:
    """Represents a block of text, composed of lines."""
    bounding_box: BoundingBox
    lines: List[Line] = field(default_factory=list)
    writing_direction: Optional[str] = None # Optional: e.g., "LEFT_TO_RIGHT"

@dataclass
class ImageProperties:
    """Stores the original dimensions of the processed image."""
    width: int
    height: int
    x: Optional[int] = None # Optional: X position of the scanned area relative to the screen(s)
    y: Optional[int] = None # Optional: Y position of the scanned area relative to the screen(s)
    window_handle: Optional[int] = None # Optional: handle of the scanned window
    window_x: Optional[int] = None # Optional: X position of the scanned area relative to the window
    window_y: Optional[int] = None # Optional: Y position of the scanned area relative to the window

@dataclass
class EngineCapabilities:
    """Represents the features natively supported by the OCR engine."""
    words: bool
    word_bounding_boxes: bool
    lines: bool
    line_bounding_boxes: bool
    paragraphs: bool
    paragraph_bounding_boxes: bool

@dataclass
class OcrResult:
    """The root object for a complete OCR analysis of an image."""
    image_properties: ImageProperties
    engine_capabilities: EngineCapabilities
    paragraphs: List[Paragraph] = field(default_factory=list)


def empty_post_process(text):
    return text


def post_process(text, keep_blank_lines=False):
    import jaconv
    text = text.replace("\"", "")
    if keep_blank_lines:
        text = '\n'.join([''.join(i.split()) for i in text.splitlines()])
    else:
        text = ''.join([''.join(i.split()) for i in text.splitlines()])
    text = text.replace('…', '・・・')
    text = re.sub('[・.]{2,}', lambda x: (x.end() - x.start()) * '・', text)
    text = re.sub(r'・{3,}', '・・・', text)
    text = jaconv.h2z(text, ascii=True, digit=True)
    return text


def input_to_pil_image(img):
    is_path = False
    if isinstance(img, Image.Image):
        pil_image = img
    elif isinstance(img, (bytes, bytearray)):
        try:
            pil_image = Image.open(io.BytesIO(img))
        except (UnidentifiedImageError, OSError):
            return None, False
    elif isinstance(img, Path):
        is_path = True
        try:
            pil_image = Image.open(img)
            pil_image.load()
        except (UnidentifiedImageError, OSError):
            return None, False
    else:
        raise ValueError(f'img must be a path, PIL.Image or bytes object, instead got: {img}')
    return pil_image, is_path


def pil_image_to_bytes(img, img_format='png', png_compression=6, jpeg_quality=80, optimize=False):
    if img_format == 'png' and optimized_png_encode and not optimize:
        raw_data = img.convert('RGBA').tobytes()
        image_bytes = fpng_py.fpng_encode_image_to_memory(raw_data, img.width, img.height)
    else:
        image_bytes = io.BytesIO()
        if img_format == 'jpeg':
            img = img.convert('RGB')
        img.save(image_bytes, format=img_format, compress_level=png_compression, quality=jpeg_quality, optimize=optimize, subsampling=0)
        image_bytes = image_bytes.getvalue()
    return image_bytes


def pil_image_to_numpy_array(img):
    return np.array(img.convert('RGBA'))


def limit_image_size(img, max_size):
    img_bytes = pil_image_to_bytes(img)
    if len(img_bytes) <= max_size:
        return img_bytes, 'png', img.size

    scaling_factor = 0.60 if any(x > 2000 for x in img.size) else 0.75
    new_w = int(img.width * scaling_factor)
    new_h = int(img.height * scaling_factor)
    resized_img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    resized_img_bytes = pil_image_to_bytes(resized_img)
    if len(resized_img_bytes) <= max_size:
        return resized_img_bytes, 'png', resized_img.size

    for _ in range(2):
        jpeg_quality = 80
        while jpeg_quality >= 60:
            img_bytes = pil_image_to_bytes(img, 'jpeg', jpeg_quality=jpeg_quality, optimize=True)
            if len(img_bytes) <= max_size:
                return img_bytes, 'jpeg', img.size
            jpeg_quality -= 5
        img = resized_img

    return False, '', (None, None)


def get_regex(lang):
    if lang == "ja":
        return re.compile(r'[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]')
    elif lang == "zh":
        return re.compile(r'[\u4E00-\u9FFF]')
    elif lang == "ko":
        return re.compile(r'[\uAC00-\uD7AF]')
    elif lang == "ar":
        return re.compile(r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]')
    elif lang == "ru":
        return re.compile(r'[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F\u1C80-\u1C8F]')
    elif lang == "el":
        return re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF]')
    elif lang == "he":
        return re.compile(r'[\u0590-\u05FF\uFB1D-\uFB4F]')
    elif lang == "th":
        return re.compile(r'[\u0E00-\u0E7F]')
    else:
        return re.compile(
        r'[a-zA-Z\u00C0-\u00FF\u0100-\u017F\u0180-\u024F\u0250-\u02AF\u1D00-\u1D7F\u1D80-\u1DBF\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\uAB30-\uAB6F]')

def quad_to_bounding_box(x1, y1, x2, y2, x3, y3, x4, y4, img_width=None, img_height=None):
    center_x = (x1 + x2 + x3 + x4) / 4
    center_y = (y1 + y2 + y3 + y4) / 4

    # Calculate widths using Euclidean distance
    width1 = sqrt((x2 - x1)**2 + (y2 - y1)**2)
    width2 = sqrt((x3 - x4)**2 + (y3 - y4)**2)
    avg_width = (width1 + width2) / 2

    # Calculate heights using Euclidean distance
    height1 = sqrt((x4 - x1)**2 + (y4 - y1)**2)
    height2 = sqrt((x3 - x2)**2 + (y3 - y2)**2)
    avg_height = (height1 + height2) / 2

    # Calculate rotation angle from the first edge
    dx = x2 - x1
    dy = y2 - y1
    angle = atan2(dy, dx)

    if img_width and img_height:
        center_x = center_x / img_width
        center_y = center_y / img_height
        avg_width = avg_width / img_width
        avg_height = avg_height / img_height

    return BoundingBox(
        center_x=center_x,
        center_y=center_y,
        width=avg_width,
        height=avg_height,
        rotation_z=angle
    )

def rectangle_to_bounding_box(x1, y1, x2, y2, img_width=None, img_height=None):
    width = x2 - x1
    height = y2 - y1

    center_x = (x1 + x2) / 2
    center_y = (y1 + y2) / 2

    if img_width and img_height:
        width = width / img_width
        height = height / img_height
        center_x = center_x / img_width
        center_y = center_y / img_height

    return BoundingBox(
        center_x=center_x,
        center_y=center_y,
        width=width,
        height=height
    )

def merge_bounding_boxes(ocr_element_list, rotated=False):
    def _get_all_corners(ocr_element_list):
        corners = []
        for element in ocr_element_list:
            bbox = element.bounding_box
            angle = bbox.rotation_z or 0.0
            hw, hh = bbox.width / 2.0, bbox.height / 2.0
            cx, cy = bbox.center_x, bbox.center_y

            # Local corner offsets
            local = np.array([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]])

            if abs(angle) < 1e-12:
                corners.append(local + [cx, cy])
            else:
                # Rotation matrix
                cos_a, sin_a = np.cos(angle), np.sin(angle)
                rot = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
                corners.append(local @ rot.T + [cx, cy])

        return np.vstack(corners) if corners else np.empty((0, 2))

    def _convex_hull(points):
        if len(points) <= 3:
            return points

        pts = np.unique(points, axis=0)
        pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]

        if len(pts) <= 1:
            return pts

        def cross(o, a, b):
            return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

        lower, upper = [], []
        for p in pts:
            while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
                lower.pop()
            lower.append(p)
        for p in pts[::-1]:
            while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
                upper.pop()
            upper.append(p)

        return np.array(lower[:-1] + upper[:-1])

    all_corners = _get_all_corners(ocr_element_list)

    # Axis-aligned case
    if not rotated:
        min_pt, max_pt = all_corners.min(axis=0), all_corners.max(axis=0)
        center = (min_pt + max_pt) / 2
        size = max_pt - min_pt
        return BoundingBox(
            center_x=center[0],
            center_y=center[1],
            width=size[0],
            height=size[1]
        )

    hull = _convex_hull(all_corners)
    m = len(hull)

    # Trivial cases
    if m == 1:
        return BoundingBox(
            center_x=hull[0, 0],
            center_y=hull[0, 1],
            width=0.0,
            height=0.0,
            rotation_z=0.0
        )

    if m == 2:
        diff = hull[1] - hull[0]
        length = np.linalg.norm(diff)
        center = hull.mean(axis=0)
        return BoundingBox(
            center_x=center[0],
            center_y=center[1],
            width=length,
            height=0.0,
            rotation_z=np.arctan2(diff[1], diff[0])
        )

    # Test each edge orientation
    edges = np.roll(hull, -1, axis=0) - hull
    edge_lengths = np.linalg.norm(edges, axis=1)
    valid = edge_lengths > 1e-12

    if not valid.any():
        # Fallback to axis-aligned
        min_pt, max_pt = all_corners.min(axis=0), all_corners.max(axis=0)
        center = (min_pt + max_pt) / 2
        size = max_pt - min_pt
        return BoundingBox(
            center_x=center[0],
            center_y=center[1],
            width=size[0],
            height=size[1]
        )

    angles = np.arctan2(edges[valid, 1], edges[valid, 0])
    best_area, best_idx = np.inf, -1

    for idx, angle in enumerate(angles):
        # Rotation matrix (rotate by -angle)
        cos_a, sin_a = np.cos(angle), np.sin(angle)
        rot = np.array([[cos_a, sin_a], [-sin_a, cos_a]])
        rotated = hull @ rot.T

        min_pt, max_pt = rotated.min(axis=0), rotated.max(axis=0)
        area = np.prod(max_pt - min_pt)

        if area < best_area:
            best_area, best_idx = area, idx
            best_bounds = (min_pt, max_pt, angle)

    min_pt, max_pt, angle = best_bounds
    width, height = max_pt - min_pt
    center_rot = (min_pt + max_pt) / 2

    # Rotate center back to global coordinates
    cos_a, sin_a = np.cos(angle), np.sin(angle)
    rot_back = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
    center = rot_back @ center_rot

    # Normalize angle to [-π, π]
    angle = np.mod(angle + np.pi, 2 * np.pi) - np.pi

    return BoundingBox(
        center_x=center[0],
        center_y=center[1],
        width=width,
        height=height,
        rotation_z=angle
    )


def initialize_manga_ocr(pretrained_model_name_or_path, force_cpu):
    def empty_post_process(text):
        text = re.sub(r'\s+', '', text)
        return text

    global manga_ocr_model
    if not manga_ocr_model:
        logger.disable('manga_ocr')
        logging.getLogger('transformers').setLevel(logging.ERROR) # silence transformers >=4.46 warnings
        from manga_ocr import ocr
        ocr.post_process = empty_post_process
        logger.info(f'Loading Manga OCR model')
        manga_ocr_model = MOCR(pretrained_model_name_or_path, force_cpu)

def _line_metrics_from_quad_rect(bounding_rect):
    if not bounding_rect:
        return 0.0, 0.0, 0.0, 0.0

    x_coords = [float(bounding_rect.get(f'x{i}', 0.0)) for i in range(1, 5)]
    y_coords = [float(bounding_rect.get(f'y{i}', 0.0)) for i in range(1, 5)]

    center_x = sum(x_coords) / 4.0
    center_y = sum(y_coords) / 4.0
    width = max(x_coords) - min(x_coords)
    height = max(y_coords) - min(y_coords)

    return center_x, center_y, width, height


def line_dict_to_spatial_entry(line_dict, is_vertical=False):
    line_text = line_dict.get('text', '')
    center_x, center_y, width, height = _line_metrics_from_quad_rect(line_dict.get('bounding_rect', {}))
    return {
        'text': line_text,
        'center_x': center_x,
        'center_y': center_y,
        'width': width,
        'height': height,
        'is_vertical': bool(is_vertical),
    }


def _should_insert_inter_line_space(previous_text, current_text):
    if not previous_text or not current_text:
        return False
    if previous_text[-1].isspace() or current_text[0].isspace():
        return False
    if previous_text[-1] in "([{\"'\u300c\u300e\uff08\u3010\u3008\u300a\uff3b\uff5b\uff1c":
        return False
    if re.match(r"^[\)\]\}\.,!?:;%\u2026\uff0c\u3002\u3001\uff1f\uff01\uff1a\uff1b\u300d\u300f\uff09\u3011\u3009\u300b\uff3d\uff5d\uff1e]", current_text):
        return False
    return True


def build_spatial_text(
    line_entries,
    same_axis_height_ratio=0.6,
    blank_line_height_ratio=2.0,
    blank_line_token=None,
):
    text_parts = []
    previous = None

    for entry in line_entries:
        line_text = str(entry.get('text', '') or '')
        if not line_text:
            continue

        if previous is not None:
            separator = '\n'

            use_vertical_axis = bool(previous.get('is_vertical')) and bool(entry.get('is_vertical'))

            if use_vertical_axis:
                prev_axis_center = previous.get('center_x')
                curr_axis_center = entry.get('center_x')
                prev_axis_dimension = max(float(previous.get('width') or 0.0), 1.0)
                curr_axis_dimension = max(float(entry.get('width') or 0.0), 1.0)
            else:
                prev_axis_center = previous.get('center_y')
                curr_axis_center = entry.get('center_y')
                prev_axis_dimension = max(float(previous.get('height') or 0.0), 1.0)
                curr_axis_dimension = max(float(entry.get('height') or 0.0), 1.0)

            if prev_axis_center is not None and curr_axis_center is not None:
                axis_distance = abs(float(curr_axis_center) - float(prev_axis_center))
                same_axis_threshold = max(prev_axis_dimension, curr_axis_dimension) * float(same_axis_height_ratio)
                if axis_distance <= same_axis_threshold:
                    separator = ' ' if _should_insert_inter_line_space(previous.get('text', ''), line_text) else ''
                else:
                    avg_dimension = (prev_axis_dimension + curr_axis_dimension) / 2.0
                    if blank_line_token and axis_distance > avg_dimension * float(blank_line_height_ratio):
                        separator = f'\n{blank_line_token}\n'

            text_parts.append(separator)

        text_parts.append(line_text)
        previous = entry

    return ''.join(text_parts)


def ocr_result_to_oneocr_tuple(result_tuple, furigana_filter_sensitivity=0, prefer_axis_spacing=False):
    success, ocr_result = result_tuple
    if not success:
        return result_tuple 
    
    # If it's just text or list of text (legacy/simple engines), return mimic tuple
    if isinstance(ocr_result, list) and len(ocr_result) > 0 and isinstance(ocr_result[0], str):
        res = ''.join(ocr_result)
        return (True, res, None, None, None, None)
    
    if isinstance(ocr_result, str):
         return (True, ocr_result, None, None, None, None)

    if not isinstance(ocr_result, OcrResult):
        # Fallback for unknown types
        return (True, str(ocr_result), None, None, None, None)

    try:
        furigana_filter_sensitivity = int(furigana_filter_sensitivity or 0)
    except (TypeError, ValueError):
        furigana_filter_sensitivity = 0

    # Convert OcrResult to OneOCR format
    img_width = ocr_result.image_properties.width
    img_height = ocr_result.image_properties.height
    
    full_text_entries = []
    filtered_lines = []
    crop_coords_list = []
    
    regex_obj = get_regex(get_ocr_language())
    
    for paragraph in ocr_result.paragraphs:
        paragraph_is_vertical = bool(paragraph.writing_direction == 'TOP_TO_BOTTOM')
        for line in paragraph.lines:
             if not line.text:
                 continue

             # Convert Normalized BBox to OneOCR-style pixel bounding_rect
             # OneOCR uses x1, y1, x2, y2, x3, y3, x4, y4 (quad) 
             # Our BoundingBox is center/width/height/rotation
             
             bbox = line.bounding_box
             w, h = bbox.width * img_width, bbox.height * img_height
             cx, cy = bbox.center_x * img_width, bbox.center_y * img_height
             angle = bbox.rotation_z or 0.0
             
             # Calculate corners
             # Local corners
             local = np.array([[-w/2, -h/2], [w/2, -h/2], [w/2, h/2], [-w/2, h/2]])
             if abs(angle) < 1e-12:
                 corners = local + [cx, cy]
             else:
                 # Rotation matrix
                 cos_a, sin_a = np.cos(angle), np.sin(angle)
                 rot = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
                 corners = local @ rot.T + [cx, cy]
                 
             # Flatten to x1, y1, x2, y2, x3, y3, x4, y4 (TL, TR, BR, BL)
             bounding_rect = {
                 'x1': int(corners[0][0]), 'y1': int(corners[0][1]),
                 'x2': int(corners[1][0]), 'y2': int(corners[1][1]),
                 'x3': int(corners[2][0]), 'y3': int(corners[2][1]),
                 'x4': int(corners[3][0]), 'y4': int(corners[3][1])
             }
             
             # Regex filter
             if not regex_obj.search(line.text):
                 continue
                 
             # Size filtering (furigana filter)
             # OneOCR logic: width > sens AND height > sens
             line_width_px = w
             line_height_px = h
             
             if furigana_filter_sensitivity > 0:
                 if not (line_width_px > furigana_filter_sensitivity and line_height_px > furigana_filter_sensitivity):
                     # Skip logic (OneOCR just appends punctuation or skips)
                     # For now, we just skip adding it to filtered_lines
                     # But wait, we should skip adding it to FULL TEXT too?
                     # OneOCR accumulates text from filtered lines + skipped punctuation.
                     # This function reconstructs full_text from filtered lines.
                     continue

             # Build words list for this line
             words_list = []
             for word in line.words:
                 wb = word.bounding_box
                 ww, wh = wb.width * img_width, wb.height * img_height
                 wcx, wcy = wb.center_x * img_width, wb.center_y * img_height
                 wangle = wb.rotation_z or 0.0
                 
                 wlocal = np.array([[-ww/2, -wh/2], [ww/2, -wh/2], [ww/2, wh/2], [-ww/2, wh/2]])
                 if abs(wangle) < 1e-12:
                     wcorners = wlocal + [wcx, wcy]
                 else:
                     cos_a, sin_a = np.cos(wangle), np.sin(wangle)
                     rot = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
                     wcorners = wlocal @ rot.T + [wcx, wcy]
                     
                 w_rect = {
                     'x1': int(wcorners[0][0]), 'y1': int(wcorners[0][1]),
                     'x2': int(wcorners[1][0]), 'y2': int(wcorners[1][1]),
                     'x3': int(wcorners[2][0]), 'y3': int(wcorners[2][1]),
                     'x4': int(wcorners[3][0]), 'y4': int(wcorners[3][1])
                 }
                 words_list.append({'text': word.text, 'bounding_rect': w_rect})

             line_dict = {
                 'text': line.text,
                 'bounding_rect': bounding_rect,
                 'words': words_list
             }
             
             filtered_lines.append(line_dict)
             full_text_entries.append({
                 'text': line.text,
                 'center_x': cx,
                 'center_y': cy,
                 'width': w,
                 'height': h,
                 'is_vertical': paragraph_is_vertical,
             })
             
             crop_coords_list.append((
                 bounding_rect['x1'] - 5, bounding_rect['y1'] - 5,
                 bounding_rect['x3'] + 5, bounding_rect['y3'] + 5,
                 line.text
             ))

    # Calculate overall crop_coords
    crop_coords = None
    if filtered_lines:
        x_coords = [line['bounding_rect'][f'x{i}'] for line in filtered_lines for i in range(1, 5)]
        y_coords = [line['bounding_rect'][f'y{i}'] for line in filtered_lines for i in range(1, 5)]
        if x_coords and y_coords:
            crop_coords = (min(x_coords) - 5, min(y_coords) - 5, max(x_coords) + 5, max(y_coords) + 5)

    if prefer_axis_spacing:
        full_text = build_spatial_text(full_text_entries, blank_line_token='BLANK_LINE')
    else:
        full_text = '\n'.join(entry['text'] for entry in full_text_entries)
            
    # return_resp is roughly the OcrResult structure but as a dict if possible or just the OcrResult
    return_resp = asdict(ocr_result)
    
    return (True, full_text.strip(), filtered_lines, crop_coords_list, crop_coords, return_resp)


class MangaOcrSegmented:
    name = 'mangaocrs'
    readable_name = 'Manga OCR (segmented)'
    key = 'n'
    config_entry = 'mangaocr'
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=True
    )

    def __init__(self, config={}):
        if 'manga_ocr' not in sys.modules:
            logger.warning('manga-ocr not available, Manga OCR (segmented) will not work!')
        elif 'scipy' not in sys.modules:
            logger.warning('scipy not available, Manga OCR (segmented) will not work!')
        else:
            comic_text_detector_path = Path.home() / ".cache" / "manga-ocr"
            comic_text_detector_file = comic_text_detector_path / "comictextdetector.pt"

            if not comic_text_detector_file.exists():
                comic_text_detector_path.mkdir(parents=True, exist_ok=True)
                logger.info('Downloading comic text detector model ' + str(comic_text_detector_file))
                try:
                    urllib.request.urlretrieve('https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt', str(comic_text_detector_file))
                except:
                    logger.warning('Download failed. Manga OCR (segmented) will not work!')
                    return

            pretrained_model_name_or_path = config.get('pretrained_model_name_or_path', 'kha-white/manga-ocr-base')
            force_cpu = config.get('force_cpu', False)
            initialize_manga_ocr(pretrained_model_name_or_path, force_cpu)

            if not force_cpu and torch.cuda.is_available():
                device = 'cuda'
            elif not force_cpu and torch.backends.mps.is_available():
                device = 'mps'
            else:
                device = 'cpu'
            logger.info(f'Loading comic text detector model, using device {device}')
            self.text_detector_model = TextDetector(model_path=comic_text_detector_file, input_size=1024, device=device, act='leaky')

            self.available = True
            logger.info('Manga OCR (segmented) ready')

    def _convert_line_bbox(self, rect, img_width, img_height):
        (x1, y1), (x2, y2), (x3, y3), (x4, y4) = [(float(x), float(y)) for x, y in rect]
        return quad_to_bounding_box(x1, y1, x2, y2, x3, y3, x4, y4, img_width, img_height)

    def _convert_box_bbox(self, rect, img_width, img_height):
        x1, y1, x2, y2 = map(float, rect)
        return rectangle_to_bounding_box(x1, y1, x2, y2, img_width, img_height)

    # from https://github.com/kha-white/mokuro/blob/master/mokuro/manga_page_ocr.py
    def _split_into_chunks(self, img, mask_refined, blk, line_idx, textheight, max_ratio, anchor_window):
        line_crop = blk.get_transformed_region(img, line_idx, textheight)

        h, w, *_ = line_crop.shape
        ratio = w / h

        if ratio <= max_ratio:
            return [line_crop], []
        else:
            k = gaussian(textheight * 2, textheight / 8)

            line_mask = blk.get_transformed_region(mask_refined, line_idx, textheight)
            num_chunks = int(np.ceil(ratio / max_ratio))

            anchors = np.linspace(0, w, num_chunks + 1)[1:-1]

            line_density = line_mask.sum(axis=0)
            line_density = np.convolve(line_density, k, 'same')
            line_density /= line_density.max()

            anchor_window *= textheight

            cut_points = []
            for anchor in anchors:
                anchor = int(anchor)

                n0 = np.clip(anchor - anchor_window // 2, 0, w)
                n1 = np.clip(anchor + anchor_window // 2, 0, w)

                p = line_density[n0:n1].argmin()
                p += n0

                cut_points.append(p)

            return np.split(line_crop, cut_points, axis=1), cut_points

    # derived from https://github.com/kha-white/mokuro/blob/master/mokuro/manga_page_ocr.py
    def _to_generic_result(self, mask_refined, blk_list, img_np, img_height, img_width):
        paragraphs = []
        for blk_idx, blk in enumerate(blk_list):
            lines = []
            for line_idx, line in enumerate(blk.lines_array()):
                if blk.vertical:
                    max_ratio = 16
                else:
                    max_ratio = 8

                line_crops, cut_points = self._split_into_chunks(
                    img_np,
                    mask_refined,
                    blk,
                    line_idx,
                    textheight=64,
                    max_ratio=max_ratio,
                    anchor_window=2,
                )

                l_text = ''
                for line_crop in line_crops:
                    if blk.vertical:
                        line_crop = cv2.rotate(line_crop, cv2.ROTATE_90_CLOCKWISE)
                    l_text += manga_ocr_model(Image.fromarray(line_crop))
                l_bbox = self._convert_line_bbox(line.tolist(), img_width, img_height)

                word = Word(
                    text=l_text,
                    bounding_box=l_bbox
                )
                words = [word]

                line = Line(
                    text=l_text,
                    bounding_box=l_bbox,
                    words=words
                )

                lines.append(line)

            p_bbox = self._convert_box_bbox(list(blk.xyxy), img_width, img_height)
            writing_direction = 'TOP_TO_BOTTOM' if blk.vertical else "LEFT_TO_RIGHT"
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines, writing_direction=writing_direction)

            paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        img_np = pil_image_to_numpy_array(img)
        img_width, img_height = img.size

        _, mask_refined, blk_list = self.text_detector_model(img_np, refine_mode=1, keep_undetected_mask=True)
        ocr_result = self._to_generic_result(mask_refined, blk_list, img_np, img_height, img_width)
        
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

class MangaOcr:
    name = 'mangaocr'
    readable_name = 'Manga OCR'
    key = 'm'
    config_entry = 'mangaocr'
    available = False
    local = True
    manual_language = False
    coordinate_support = False
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={'pretrained_model_name_or_path':'kha-white/manga-ocr-base','force_cpu': False}, lang='ja'):
        if 'manga_ocr' not in sys.modules:
            logger.warning('manga-ocr not available, Manga OCR will not work!')
        else:
            pretrained_model_name_or_path = config.get('pretrained_model_name_or_path', 'kha-white/manga-ocr-base')
            force_cpu = config.get('force_cpu', False)
            initialize_manga_ocr(pretrained_model_name_or_path, force_cpu)
            self.available = True
            logger.info('Manga OCR ready')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        x = (True, manga_ocr_model(img), None, None, None, None)

        # img.close()
        return x

class GoogleVision:
    name = 'gvision'
    readable_name = 'Google Vision'
    key = 'g'
    config_entry = None
    available = False
    local = False
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = {
        'words': True,
        'word_bounding_boxes': True,
        'lines': True,
        'line_bounding_boxes': False,
        'paragraphs': True,
        'paragraph_bounding_boxes': True
    }

    def __init__(self, lang='ja'):
        if 'google.cloud' not in sys.modules:
            logger.warning('google-cloud-vision not available, Google Vision will not work!')
        else:
            logger.info(f'Parsing Google credentials')
            google_credentials_file = os.path.join(os.path.expanduser('~'),'.config','google_vision.json')
            try:
                google_credentials = service_account.Credentials.from_service_account_file(google_credentials_file)
                self.client = vision.ImageAnnotatorClient(credentials=google_credentials)
                self.available = True
                logger.info('Google Vision ready')
            except:
                logger.warning('Error parsing Google credentials, Google Vision will not work!')

    def _break_type_to_char(self, break_type):
        if break_type == vision.TextAnnotation.DetectedBreak.BreakType.SPACE:
            return ' '
        elif break_type == vision.TextAnnotation.DetectedBreak.BreakType.SURE_SPACE:
            return ' '
        elif break_type == vision.TextAnnotation.DetectedBreak.BreakType.EOL_SURE_SPACE:
            return '\n'
        elif break_type == vision.TextAnnotation.DetectedBreak.BreakType.HYPHEN:
            return '-'
        elif break_type == vision.TextAnnotation.DetectedBreak.BreakType.LINE_BREAK:
            return '\n'
        return ''

    def _convert_bbox(self, quad, img_width, img_height):
        vertices = quad.vertices

        return quad_to_bounding_box(
            vertices[0].x, vertices[0].y,
            vertices[1].x, vertices[1].y,
            vertices[2].x, vertices[2].y,
            vertices[3].x, vertices[3].y,
            img_width, img_height
        )

    def _create_word_from_google_word(self, google_word, img_width, img_height):
        w_bbox = self._convert_bbox(google_word.bounding_box, img_width, img_height)

        w_separator = ''
        w_text_parts = []
        for i, symbol in enumerate(google_word.symbols):
            separator = None
            if hasattr(symbol, 'property') and hasattr(symbol.property, 'detected_break'):
                detected_break = symbol.property.detected_break
                detected_separator = self._break_type_to_char(detected_break.type_)
                if i == len(google_word.symbols) - 1:
                    w_separator = detected_separator
                else:
                    separator = detected_separator
            symbol_text = symbol.text
            w_text_parts.append(symbol_text)
            if separator:
                w_text_parts.append(separator)
        word_text = ''.join(w_text_parts)

        return Word(
            text=word_text,
            bounding_box=w_bbox,
            separator=w_separator
        )

    def _create_lines_from_google_paragraph(self, google_paragraph, p_bbox, img_width, img_height):
        lines = []
        words = []
        for google_word in google_paragraph.words:
            word = self._create_word_from_google_word(google_word, img_width, img_height)
            words.append(word)
            if word.separator == '\n':
                line = Line(bounding_box=BoundingBox(0,0,0,0), words=words)
                lines.append(line)
                words = []

        if len(lines) == 1:
            lines[0].bounding_box = p_bbox
        else:
            for line in lines:
                l_bbox = merge_bounding_boxes(line.words)
                line.bounding_box = l_bbox

        return lines

    def _to_generic_result(self, full_text_annotation, img_width, img_height):
        paragraphs = []

        if full_text_annotation:
            for page in full_text_annotation.pages:
                if page.width == img_width and page.height == img_height:
                    for block in page.blocks:
                        for google_paragraph in block.paragraphs:
                            p_bbox = self._convert_bbox(google_paragraph.bounding_box, img_width, img_height)
                            lines = self._create_lines_from_google_paragraph(google_paragraph, p_bbox, img_width, img_height)
                            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
                            paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        image_bytes = self._preprocess(img)
        image = vision.Image(content=image_bytes)

        try:
            response = self.client.document_text_detection(image=image)
        except ServiceUnavailable:
            return (False, 'Connection error!')
        except Exception as e:
            return (False, 'Unknown error!')

        ocr_result = self._to_generic_result(response.full_text_annotation, img.width, img.height)
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img)


class GoogleLens:
    name = 'glens'
    readable_name = 'Google Lens'
    key = 'l'
    config_entry = None
    available = False
    local = False
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=True
    )

    def __init__(self, lang='ja', get_furigana_sens_from_file=True):
        import regex
        self.regex = get_regex(lang)
        self.initial_lang = lang
        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}]')
        self.get_furigana_sens_from_file = get_furigana_sens_from_file
        if LensOverlayServerRequestPb2 is None or LensOverlayServerResponsePb2 is None or MessageToDict is None:
            logger.warning('Google Lens dependencies not available, Google Lens will not work!')
        else:
            self.available = True
            logger.info('Google Lens ready')

    @staticmethod
    def _is_timeout_error(exc):
        candidates = []
        direct = getattr(curl_cffi, 'exceptions', None)
        if direct is not None:
            timeout_cls = getattr(direct, 'Timeout', None)
            if timeout_cls is not None:
                candidates.append(timeout_cls)
        req = getattr(curl_cffi, 'requests', None)
        req_exceptions = getattr(req, 'exceptions', None) if req is not None else None
        if req_exceptions is not None:
            timeout_cls = getattr(req_exceptions, 'Timeout', None)
            if timeout_cls is not None:
                candidates.append(timeout_cls)
        return any(isinstance(exc, c) for c in candidates)

    @staticmethod
    def _is_connection_error(exc):
        candidates = []
        direct = getattr(curl_cffi, 'exceptions', None)
        if direct is not None:
            conn_cls = getattr(direct, 'ConnectionError', None)
            if conn_cls is not None:
                candidates.append(conn_cls)
        req = getattr(curl_cffi, 'requests', None)
        req_exceptions = getattr(req, 'exceptions', None) if req is not None else None
        if req_exceptions is not None:
            conn_cls = getattr(req_exceptions, 'ConnectionError', None)
            if conn_cls is not None:
                candidates.append(conn_cls)
        return any(isinstance(exc, c) for c in candidates)

    def __call__(self, img, furigana_filter_sensitivity=0, return_coords=False):
        if self.get_furigana_sens_from_file:
            furigana_filter_sensitivity = get_furigana_filter_sensitivity()
        else:
            furigana_filter_sensitivity = furigana_filter_sensitivity
        lang = get_ocr_language()
        if lang != self.initial_lang:
            self.initial_lang = lang
            self.regex = get_regex(lang)

        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        if not self.available:
            if is_path:
                img.close()
            return (False, 'Google Lens is not available.')

        try:
            request = LensOverlayServerRequestPb2()

            request.objects_request.request_context.request_id.uuid = random.randint(0, 2**64 - 1)
            request.objects_request.request_context.request_id.sequence_id = 0
            request.objects_request.request_context.request_id.image_sequence_id = 0
            request.objects_request.request_context.request_id.analytics_id = random.randbytes(16)

            request.objects_request.request_context.request_id.routing_info.Clear()
            request.objects_request.request_context.client_context.platform = PLATFORM_WEB
            request.objects_request.request_context.client_context.surface = SURFACE_CHROMIUM

            request.objects_request.request_context.client_context.locale_context.language = 'ja'
            request.objects_request.request_context.client_context.locale_context.region = 'Asia/Tokyo'
            request.objects_request.request_context.client_context.locale_context.time_zone = '' # not set by chromium

            request.objects_request.request_context.client_context.app_id = '' # not set by chromium

            request_filter = request.objects_request.request_context.client_context.client_filters.filter.add()
            request_filter.filter_type = AUTO_FILTER

            image_data = self._preprocess(img)
            request.objects_request.image_data.payload.image_bytes = image_data[0]
            request.objects_request.image_data.image_metadata.width = image_data[1]
            request.objects_request.image_data.image_metadata.height = image_data[2]

            payload = request.SerializeToString()

            headers = {
                'Host': 'lensfrontend-pa.googleapis.com',
                'Connection': 'keep-alive',
                'Content-Type': 'application/x-protobuf',
                'X-Goog-Api-Key': 'AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Dest': 'empty',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Accept-Language': 'ja-JP;q=0.6,ja;q=0.5'
            }

            try:
                res = curl_cffi.post('https://lensfrontend-pa.googleapis.com/v1/crupload', data=payload, headers=headers, impersonate='chrome', timeout=20)
            except Exception as e:
                if self._is_timeout_error(e):
                    return (False, 'Request timeout!')
                if self._is_connection_error(e):
                    return (False, 'Connection error!')
                return (False, 'Unknown error!')

            if res.status_code != 200:
                return (False, 'Unknown error!')

            response_proto = LensOverlayServerResponsePb2()
            response_proto.ParseFromString(res.content)
            response_dict = MessageToDict(response_proto, preserving_proto_field_name=True)

            text = response_dict.get('objects_response', {}).get('text', {})
            skipped = []
            line_entries = []
            filtered_lines = []
            crop_coords_list = []
            filtered_response_dict = response_dict
            if furigana_filter_sensitivity:
                import copy
                filtered_response_dict = copy.deepcopy(response_dict)
                filtered_paragraphs = []

            def _lens_box_to_rect(box):
                box = box or {}
                line_center_x = float(box.get('center_x', 0.0)) * img.width
                line_center_y = float(box.get('center_y', 0.0)) * img.height
                line_width_px = float(box.get('width', 0.0)) * img.width
                line_height_px = float(box.get('height', 0.0)) * img.height
                half_w = line_width_px / 2.0
                half_h = line_height_px / 2.0
                return (
                    {
                        'x1': int(line_center_x - half_w), 'y1': int(line_center_y - half_h),
                        'x2': int(line_center_x + half_w), 'y2': int(line_center_y - half_h),
                        'x3': int(line_center_x + half_w), 'y3': int(line_center_y + half_h),
                        'x4': int(line_center_x - half_w), 'y4': int(line_center_y + half_h),
                    },
                    line_center_x,
                    line_center_y,
                    line_width_px,
                    line_height_px,
                )

            if 'text_layout' in text:
                for paragraph in text['text_layout'].get('paragraphs', []):
                    paragraph_direction = str(paragraph.get('writing_direction', ''))
                    paragraph_is_vertical = 'TOP_TO_BOTTOM' in paragraph_direction
                    passed_furigana_filter_lines = []
                    for line in paragraph.get('lines', []):
                        line_bbox = line.get('geometry', {}).get('bounding_box', {})
                        line_rect, line_center_x, line_center_y, line_width_px, line_height_px = _lens_box_to_rect(line_bbox)
                        words = line.get('words', [])
                        line_text_parts = []
                        line_words = []
                        passes = True

                        if furigana_filter_sensitivity:
                            line_width = float(line_bbox.get('width', 0.0)) * img.width
                            line_height = float(line_bbox.get('height', 0.0)) * img.height
                            passes = line_width > furigana_filter_sensitivity and line_height > furigana_filter_sensitivity

                            for word in words:
                                word_text = word.get('plain_text', '')
                                word_separator = word.get('text_separator', '') or ''
                                if passes or self.punctuation_regex.findall(word_text):
                                    line_text_parts.append(word_text + word_separator)
                                else:
                                    skipped.extend(word_text)
                            if passes:
                                passed_furigana_filter_lines.append(line)
                        else:
                            for word in words:
                                line_text_parts.append((word.get('plain_text', '') + (word.get('text_separator', '') or '')))

                        for word in words:
                            word_text = str(word.get('plain_text', '') or '')
                            word_bbox = word.get('geometry', {}).get('bounding_box', {})
                            word_rect, _, _, _, _ = _lens_box_to_rect(word_bbox)
                            if not word_text:
                                continue
                            line_words.append({
                                'text': word_text,
                                'bounding_rect': word_rect
                            })

                        if len(line_words) == 1:
                            coarse_word = line_words[0]
                            coarse_text = coarse_word.get('text', '')
                            if coarse_text and coarse_text == ''.join(line_text_parts).strip() and _screen_ai_contains_cjk(coarse_text) and len(coarse_text) > 1:
                                x1 = float(line_rect['x1'])
                                y1 = float(line_rect['y1'])
                                x3 = float(line_rect['x3'])
                                y3 = float(line_rect['y3'])
                                char_count = len(coarse_text)
                                if paragraph_is_vertical:
                                    char_h = (y3 - y1) / max(char_count, 1)
                                    rebuilt_words = []
                                    for idx, char in enumerate(coarse_text):
                                        cy1 = y1 + idx * char_h
                                        cy2 = y1 + (idx + 1) * char_h
                                        rebuilt_words.append({
                                            'text': char,
                                            'bounding_rect': {
                                                'x1': int(x1), 'y1': int(cy1),
                                                'x2': int(x3), 'y2': int(cy1),
                                                'x3': int(x3), 'y3': int(cy2),
                                                'x4': int(x1), 'y4': int(cy2),
                                            }
                                        })
                                    line_words = rebuilt_words
                                else:
                                    char_w = (x3 - x1) / max(char_count, 1)
                                    rebuilt_words = []
                                    for idx, char in enumerate(coarse_text):
                                        cx1 = x1 + idx * char_w
                                        cx2 = x1 + (idx + 1) * char_w
                                        rebuilt_words.append({
                                            'text': char,
                                            'bounding_rect': {
                                                'x1': int(cx1), 'y1': int(y1),
                                                'x2': int(cx2), 'y2': int(y1),
                                                'x3': int(cx2), 'y3': int(y3),
                                                'x4': int(cx1), 'y4': int(y3),
                                            }
                                        })
                                    line_words = rebuilt_words

                        line_text = ''.join(line_text_parts).strip()
                        if line_text:
                            line_entries.append({
                                'text': line_text,
                                'center_x': line_center_x,
                                'center_y': line_center_y,
                                'width': line_width_px,
                                'height': line_height_px,
                                'is_vertical': paragraph_is_vertical,
                            })
                            if passes:
                                filtered_lines.append({
                                    'text': line_text,
                                    'bounding_rect': line_rect,
                                    'words': line_words,
                                })
                                crop_coords_list.append((
                                    line_rect['x1'] - 5, line_rect['y1'] - 5,
                                    line_rect['x3'] + 5, line_rect['y3'] + 5,
                                    line_text
                                ))

                    if furigana_filter_sensitivity and passed_furigana_filter_lines:
                        filtered_paragraph = paragraph.copy()
                        filtered_paragraph['lines'] = passed_furigana_filter_lines
                        filtered_paragraphs.append(filtered_paragraph)

                if furigana_filter_sensitivity:
                    filtered_response_dict['objects_response']['text']['text_layout']['paragraphs'] = filtered_paragraphs
            res_text = build_spatial_text(line_entries, blank_line_token='BLANK_LINE')

            crop_coords = None
            if filtered_lines:
                x_coords = [line['bounding_rect'][f'x{i}'] for line in filtered_lines for i in range(1, 5)]
                y_coords = [line['bounding_rect'][f'y{i}'] for line in filtered_lines for i in range(1, 5)]
                if x_coords and y_coords:
                    crop_coords = (min(x_coords) - 5, min(y_coords) - 5, max(x_coords) + 5, max(y_coords) + 5)

            x = (True, res_text,
                filtered_lines,
                crop_coords_list,
                crop_coords,
                filtered_response_dict)

            if skipped:
                logger.info(f"Skipped {len(skipped)} chars due to furigana filter sensitivity: {furigana_filter_sensitivity}")
                logger.debug(f"Skipped chars: {''.join(skipped)}")

            return x
        finally:
            if is_path:
                img.close()

    def _preprocess(self, img):
        if img.width * img.height > 3000000:
            aspect_ratio = img.width / img.height
            new_w = int(sqrt(3000000 * aspect_ratio))
            new_h = int(new_w / aspect_ratio)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        return (pil_image_to_bytes(img), img.width, img.height)

class Bing:
    name = 'bing'
    readable_name = 'Bing'
    key = 'b'
    config_entry = None
    available = False
    local = False
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=True
    )

    def __init__(self, lang='ja'):
        self.requests_session = curl_cffi.Session()
        self.available = True
        logger.info('Bing ready')

    def _convert_bbox(self, quad):
        return quad_to_bounding_box(
            quad['topLeft']['x'], quad['topLeft']['y'],
            quad['topRight']['x'], quad['topRight']['y'],
            quad['bottomRight']['x'], quad['bottomRight']['y'],
            quad['bottomLeft']['x'], quad['bottomLeft']['y']
        )

    def _to_generic_result(self, response, img_width, img_height, og_img_width, og_img_height):
        paragraphs = []
        text_tag = None
        for tag in response.get('tags', []):
            if tag.get('displayName') == '##TextRecognition':
                text_tag = tag
                break
        if text_tag:
            text_action = None
            for action in text_tag.get('actions', []):
                if action.get('_type') == 'ImageKnowledge/TextRecognitionAction':
                    text_action = action
                    break
            if text_action:
                for p in text_action.get('data', {}).get('regions', []):
                    lines = []
                    for line in p.get('lines', []):
                        words = []
                        for word in line.get('words', []):
                            word_obj = Word(
                                text=word.get('text', ''),
                                bounding_box=self._convert_bbox(word['boundingBox'])
                            )
                            words.append(word_obj)

                        line_obj = Line(
                            text=line.get('text', ''),
                            bounding_box=self._convert_bbox(line['boundingBox']),
                            words=words
                        )
                        lines.append(line_obj)

                    paragraph = Paragraph(
                        bounding_box=self._convert_bbox(p['boundingBox']),
                        lines=lines
                    )
                    paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=og_img_width, height=og_img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        img_bytes, img_size = self._preprocess(img)
        if not img_bytes:
            return (False, 'Image is too big!')

        upload_url = 'https://www.bing.com/images/search?view=detailv2&iss=sbiupload'
        upload_headers = {
            'origin': 'https://www.bing.com'
        }
        mp = curl_cffi.CurlMime()
        mp.addpart(name='imgurl', data='')
        mp.addpart(name='cbir', data='sbi')
        mp.addpart(name='imageBin', data=img_bytes)
        for _ in range(2):
            api_host = urlparse(upload_url).netloc
            try:
                res = self.requests_session.post(upload_url, headers=upload_headers, multipart=mp, allow_redirects=False, impersonate='chrome', timeout=20)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')

            if res.status_code != 302:
                return (False, 'Unknown error!')

            redirect_url = res.headers.get('Location')
            if not redirect_url:
                return (False, 'Error getting redirect URL!')
            if not redirect_url.startswith('https://'):
                break
            upload_url = redirect_url

        parsed_url = urlparse(redirect_url)
        query_params = parse_qs(parsed_url.query)

        image_insights_token = query_params.get('insightsToken')
        if not image_insights_token:
            return (False, 'Error getting token!')
        image_insights_token = image_insights_token[0]

        api_url = f'https://{api_host}/images/api/custom/knowledge'
        api_headers = {
            'origin': 'https://www.bing.com',
            'referer': f'https://www.bing.com/images/search?view=detailV2&insightstoken={image_insights_token}'
        }
        api_data_json = {
            'imageInfo': {'imageInsightsToken': image_insights_token, 'source': 'Url'},
            'knowledgeRequest': {'invokedSkills': ['OCR'], 'index': 1}
        }
        mp2 = curl_cffi.CurlMime()
        mp2.addpart(name='knowledgeRequest', content_type='application/json', data=json.dumps(api_data_json))

        try:
            res = self.requests_session.post(api_url, headers=api_headers, multipart=mp2, impersonate='chrome', timeout=20)
        except curl_cffi.requests.exceptions.Timeout:
            return (False, 'Request timeout!')
        except curl_cffi.requests.exceptions.ConnectionError:
            return (False, 'Connection error!')

        if res.status_code != 200:
            return (False, 'Unknown error!')

        data = res.json()
        img_width, img_height = img_size
        ocr_result = self._to_generic_result(data, img_width, img_height, img.width, img.height)
        
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        min_pixel_size = 50
        max_pixel_size = 4000
        max_byte_size = 767772
        res = None

        if any(x < min_pixel_size for x in img.size):
            resize_factor = max(min_pixel_size / img.width, min_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        if any(x > max_pixel_size for x in img.size):
            resize_factor = min(max_pixel_size / img.width, max_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        img_bytes, _, img_size = limit_image_size(img, max_byte_size)

        if img_bytes:
            res = base64.b64encode(img_bytes).decode('utf-8')

        return res, img_size

class AppleVision:
    name = 'avision'
    readable_name = 'Apple Vision'
    key = 'a'
    config_entry = 'avision'
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, lang='ja', config={}):
        if sys.platform != 'darwin':
            logger.warning('Apple Vision is not supported on non-macOS platforms!')
        elif int(platform.mac_ver()[0].split('.')[0]) < 13:
            logger.warning('Apple Vision is not supported on macOS older than Ventura/13.0!')
        else:
            self.recognition_level = Vision.VNRecognizeTextRequest.VNRecognizeTextRequestRevision3 # Vision.VNRecognizeTextRequestRevision3
            self.language_correction = config.get('language_correction', True)
            self.available = True
            self.language = [lang, 'en']
            logger.info('Apple Vision ready')

    def _to_generic_result(self, response, img_width, img_height):
        lines = []
        for l in response:
            bbox_raw = l.boundingBox()
            bbox = BoundingBox(
                width=bbox_raw.size.width,
                height=bbox_raw.size.height,
                center_x=bbox_raw.origin.x + (bbox_raw.size.width / 2),
                center_y=(1 - bbox_raw.origin.y - bbox_raw.size.height / 2)
            )

            word = Word(
                text=l.text(),
                bounding_box=bbox
            )
            words = [word]

            line = Line(
                text=l.text(),
                bounding_box=bbox,
                words=words
            )

            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        with objc.autorelease_pool():
            req = Vision.VNRecognizeTextRequest.alloc().init()

            req.setRevision_(Vision.VNRecognizeTextRequestRevision3)
            req.setRecognitionLevel_(self.recognition_level)
            req.setUsesLanguageCorrection_(self.language_correction)
            req.setRecognitionLanguages_(self.language)

            handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(
                self._preprocess(img), None
            )

            success = handler.performRequests_error_([req], None)
            res = []
            if success[0]:
                ocr_result = self._to_generic_result(req.results(), img.width, img.height)
                x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)
            else:
                x = (False, 'Unknown error!')

            if is_path:
                img.close()
            return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img, 'tiff')


class AppleLiveText:
    name = 'alivetext'
    readable_name = 'Apple Live Text'
    key = 'd'
    config_entry = None
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = False
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, lang='ja'):
        if sys.platform != 'darwin':
            logger.warning('Apple Live Text is not supported on non-macOS platforms!')
        elif int(platform.mac_ver()[0].split('.')[0]) < 13:
            logger.warning('Apple Live Text is not supported on macOS older than Ventura/13.0!')
        else:
            app_info = NSBundle.mainBundle().infoDictionary()
            app_info['LSBackgroundOnly'] = '1'
            self.VKCImageAnalyzer = objc.lookUpClass('VKCImageAnalyzer')
            self.VKCImageAnalyzerRequest = objc.lookUpClass('VKCImageAnalyzerRequest')
            objc.registerMetaDataForSelector(
                b'VKCImageAnalyzer',
                b'processRequest:progressHandler:completionHandler:',
                {
                    'arguments': {
                        3: {
                            'callable': {
                                'retval': {'type': b'v'},
                                'arguments': {
                                    0: {'type': b'^v'},
                                    1: {'type': b'd'},
                                }
                            }
                        },
                        4: {
                            'callable': {
                                'retval': {'type': b'v'},
                                'arguments': {
                                    0: {'type': b'^v'},
                                    1: {'type': b'@'},
                                    2: {'type': b'@'},
                                }
                            }
                        }
                    }
                }
            )
            self.language = [lang, 'en']
            self.available = True
            logger.info('Apple Live Text ready')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        self.result = None

        with objc.autorelease_pool():
            analyzer = self.VKCImageAnalyzer.alloc().init()
            req = self.VKCImageAnalyzerRequest.alloc().initWithImage_requestType_(self._preprocess(img), 1) #VKAnalysisTypeText
            req.setLocales_(self.language)
            analyzer.processRequest_progressHandler_completionHandler_(req, lambda progress: None, self._process)

            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 10.0, False)

        if self.result == None:
            return (False, 'Unknown error!')
        
        ocr_result = OcrResult(
            image_properties=ImageProperties(width=img.width, height=img.height),
            paragraphs=self.result,
            engine_capabilities=self.capabilities
        )
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

    def _process(self, analysis, error):
        lines = []
        response_lines = analysis.allLines()
        if response_lines:
            for l in response_lines:
                words = []
                for i, w in enumerate(l.children()):
                    w_bbox = w.quad().boundingBox()
                    word = Word(
                        text=w.string(),
                        bounding_box=BoundingBox(
                            width=w_bbox.size.width,
                            height=w_bbox.size.height,
                            center_x=w_bbox.origin.x + (w_bbox.size.width / 2),
                            center_y=w_bbox.origin.y + (w_bbox.size.height / 2)
                        )
                    )
                    words.append(word)

                l_bbox = l.quad().boundingBox()
                line = Line(
                    text=l.string(),
                    bounding_box=BoundingBox(
                        width=l_bbox.size.width,
                        height=l_bbox.size.height,
                        center_x=l_bbox.origin.x + (l_bbox.size.width / 2),
                        center_y=l_bbox.origin.y + (l_bbox.size.height / 2)
                    ),
                    words=words
                )
                lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        self.result = paragraphs
        CFRunLoopStop(CFRunLoopGetCurrent())

    def _preprocess(self, img):
        image_bytes = pil_image_to_bytes(img, 'tiff')
        ns_data = NSData.dataWithBytes_length_(image_bytes, len(image_bytes))
        ns_image = NSImage.alloc().initWithData_(ns_data)
        return ns_image


class WinRTOCR:
    name = 'winrtocr'
    readable_name = 'WinRT OCR'
    key = 'w'
    config_entry = 'winrtocr'
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={}, lang='ja'):
        if sys.platform == 'win32':
            if int(platform.release()) < 10:
                logger.warning('WinRT OCR is not supported on Windows older than 10!')
            elif 'winocr' not in sys.modules:
                logger.warning('winocr not available, WinRT OCR will not work!')
            else:
                self.language = lang
                self.available = True
                logger.info('WinRT OCR ready')
        else:
            try:
                self.url = config['url']
                self.language = lang
                self.available = True
                logger.info('WinRT OCR ready')
            except:
                logger.warning('Error reading URL from config, WinRT OCR will not work!')

    def _normalize_bbox(self, rect, img_width, img_height):
        x_norm = rect['x'] / img_width
        y_norm = rect['y'] / img_height
        width_norm = rect['width'] / img_width
        height_norm = rect['height'] / img_height

        # Calculate center coordinates
        center_x = x_norm + (width_norm / 2)
        center_y = y_norm + (height_norm / 2)

        return BoundingBox(
            center_x=center_x,
            center_y=center_y,
            width=width_norm,
            height=height_norm
        )

    def _to_generic_result(self, response, img_width, img_height):
        lines = []
        for l in response.get('lines', []):
            words = []
            for i, w in enumerate(l.get('words', [])):
                word = Word(
                    text=w.get('text', ''),
                    bounding_box=self._normalize_bbox(w['bounding_rect'], img_width, img_height)
                )
                words.append(word)

            l_bbox = merge_bounding_boxes(words)
            line = Line(
                text=l.get('text', ''),
                bounding_box=l_bbox,
                words=words
            )
            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        if sys.platform == 'win32':
            res = winocr.recognize_pil_sync(img, lang=self.language)
        else:
            params = {'lang': self.language}
            try:
                res = curl_cffi.post(self.url, params=params, data=self._preprocess(img), timeout=3)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')

            if res.status_code != 200:
                return (False, 'Unknown error!')

            res = res.json()

        ocr_result = self._to_generic_result(res, img.width, img.height)
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img, png_compression=1)


class _ScreenAISkColorInfo(ctypes.Structure):
    _fields_ = [
        ("fColorSpace", ctypes.c_void_p),
        ("fColorType", ctypes.c_int32),
        ("fAlphaType", ctypes.c_int32),
    ]


class _ScreenAISkISize(ctypes.Structure):
    _fields_ = [("fWidth", ctypes.c_int32), ("fHeight", ctypes.c_int32)]


class _ScreenAISkImageInfo(ctypes.Structure):
    _fields_ = [("fColorInfo", _ScreenAISkColorInfo), ("fDimensions", _ScreenAISkISize)]


class _ScreenAISkPixmap(ctypes.Structure):
    _fields_ = [
        ("fPixels", ctypes.c_void_p),
        ("fRowBytes", ctypes.c_size_t),
        ("fInfo", _ScreenAISkImageInfo),
    ]


class _ScreenAISkBitmap(ctypes.Structure):
    _fields_ = [
        ("fPixelRef", ctypes.c_void_p),
        ("fPixmap", _ScreenAISkPixmap),
        ("fFlags", ctypes.c_uint32),
    ]


class _ScreenAIProtoReader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def eof(self):
        return self.pos >= len(self.data)

    def read_varint(self):
        value = 0
        shift = 0
        while True:
            if self.pos >= len(self.data):
                raise ValueError("Unexpected EOF while reading varint")
            byte = self.data[self.pos]
            self.pos += 1
            value |= (byte & 0x7F) << shift
            if not (byte & 0x80):
                return value
            shift += 7
            if shift > 70:
                raise ValueError("Invalid varint")

    def read_bytes(self, size):
        if self.pos + size > len(self.data):
            raise ValueError("Unexpected EOF while reading bytes")
        chunk = self.data[self.pos:self.pos + size]
        self.pos += size
        return chunk

    def read_fixed32(self):
        return struct.unpack("<I", self.read_bytes(4))[0]

    def skip_field(self, wire_type):
        if wire_type == 0:
            self.read_varint()
            return
        if wire_type == 1:
            self.read_bytes(8)
            return
        if wire_type == 2:
            self.read_bytes(self.read_varint())
            return
        if wire_type == 5:
            self.read_bytes(4)
            return
        raise ValueError(f"Unsupported wire type: {wire_type}")


def _screen_ai_sanitize_text(raw_text):
    if raw_text is None:
        return ""
    return str(raw_text).replace("\r", "").replace("\n", "")


def _screen_ai_decode_float32(value):
    return struct.unpack("<f", struct.pack("<I", value))[0]


_screen_ai_cjk_regex = regex.compile(r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]")


def _screen_ai_contains_cjk(text):
    if not text:
        return False
    return bool(_screen_ai_cjk_regex.search(str(text)))


def _screen_ai_parse_rect_manual(data):
    reader = _ScreenAIProtoReader(data)
    rect = {"x": 0, "y": 0, "width": 0, "height": 0, "angle": 0.0}

    while not reader.eof():
        tag = reader.read_varint()
        field_number = tag >> 3
        wire_type = tag & 0x07

        if field_number in (1, 2, 3, 4) and wire_type == 0:
            value = reader.read_varint()
            if field_number == 1:
                rect["x"] = value
            elif field_number == 2:
                rect["y"] = value
            elif field_number == 3:
                rect["width"] = value
            elif field_number == 4:
                rect["height"] = value
            continue

        if field_number == 5 and wire_type == 5:
            rect["angle"] = _screen_ai_decode_float32(reader.read_fixed32())
            continue

        reader.skip_field(wire_type)

    return rect


def _screen_ai_parse_symbol_manual(data):
    reader = _ScreenAIProtoReader(data)
    symbol = {"text": "", "box": None, "confidence": None}

    while not reader.eof():
        tag = reader.read_varint()
        field_number = tag >> 3
        wire_type = tag & 0x07

        if field_number == 1 and wire_type == 2:
            symbol["box"] = _screen_ai_parse_rect_manual(reader.read_bytes(reader.read_varint()))
            continue

        if field_number == 2 and wire_type == 2:
            symbol["text"] = _screen_ai_sanitize_text(
                reader.read_bytes(reader.read_varint()).decode("utf-8", errors="replace")
            )
            continue

        if field_number == 3 and wire_type == 5:
            symbol["confidence"] = _screen_ai_decode_float32(reader.read_fixed32())
            continue

        reader.skip_field(wire_type)

    return symbol


def _screen_ai_parse_word_manual(data):
    reader = _ScreenAIProtoReader(data)
    word = {"text": "", "box": None, "has_space_after": False, "confidence": None, "symbols": []}

    while not reader.eof():
        tag = reader.read_varint()
        field_number = tag >> 3
        wire_type = tag & 0x07

        if field_number == 1 and wire_type == 2:
            word["symbols"].append(_screen_ai_parse_symbol_manual(reader.read_bytes(reader.read_varint())))
            continue

        if field_number == 2 and wire_type == 2:
            word["box"] = _screen_ai_parse_rect_manual(reader.read_bytes(reader.read_varint()))
            continue

        if field_number == 3 and wire_type == 2:
            word["text"] = _screen_ai_sanitize_text(
                reader.read_bytes(reader.read_varint()).decode("utf-8", errors="replace")
            )
            continue

        if field_number == 6 and wire_type == 0:
            word["has_space_after"] = bool(reader.read_varint())
            continue

        if field_number == 15 and wire_type == 5:
            word["confidence"] = _screen_ai_decode_float32(reader.read_fixed32())
            continue

        reader.skip_field(wire_type)

    return word


def _screen_ai_parse_line_manual(data):
    reader = _ScreenAIProtoReader(data)
    line = {"text": "", "box": None, "language": "", "confidence": None, "words": []}

    while not reader.eof():
        tag = reader.read_varint()
        field_number = tag >> 3
        wire_type = tag & 0x07

        if field_number == 1 and wire_type == 2:
            line["words"].append(_screen_ai_parse_word_manual(reader.read_bytes(reader.read_varint())))
            continue

        if field_number == 2 and wire_type == 2:
            line["box"] = _screen_ai_parse_rect_manual(reader.read_bytes(reader.read_varint()))
            continue

        if field_number == 3 and wire_type == 2:
            line["text"] = _screen_ai_sanitize_text(
                reader.read_bytes(reader.read_varint()).decode("utf-8", errors="replace")
            )
            continue

        if field_number == 4 and wire_type == 2:
            line["language"] = reader.read_bytes(reader.read_varint()).decode("utf-8", errors="replace")
            continue

        if field_number == 10 and wire_type == 5:
            line["confidence"] = _screen_ai_decode_float32(reader.read_fixed32())
            continue

        reader.skip_field(wire_type)

    if not line["text"] and line["words"]:
        line["text"] = "".join(
            w["text"] + (" " if w["has_space_after"] else "")
            for w in line["words"]
        ).rstrip()

    return line


def _screen_ai_parse_visual_annotation_manual(data):
    reader = _ScreenAIProtoReader(data)
    lines = []

    while not reader.eof():
        tag = reader.read_varint()
        field_number = tag >> 3
        wire_type = tag & 0x07
        if field_number == 2 and wire_type == 2:
            line = _screen_ai_parse_line_manual(reader.read_bytes(reader.read_varint()))
            if line["text"].strip():
                lines.append(line)
            continue
        reader.skip_field(wire_type)

    return lines


class ScreenAIOCR:
    name = 'screenai'
    readable_name = 'ScreenAI OCR'
    key = 'q'
    config_entry = 'screenai'
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )
    _shared_runtime = None

    @staticmethod
    def _library_names_for_platform(config):
        candidates = []
        configured = str(config.get('library_name', '')).strip() if isinstance(config, dict) else ''
        if configured:
            candidates.append(configured)

        if sys.platform == 'win32':
            candidates.append('chrome_screen_ai.dll')
        elif sys.platform.startswith('linux'):
            candidates.append('libchromescreenai.so')
        elif sys.platform == 'darwin':
            candidates.extend(['libchromescreenai.dylib', 'libchromescreenai.so'])

        deduped = []
        for candidate in candidates:
            if candidate and candidate not in deduped:
                deduped.append(candidate)
        return deduped

    def __init__(self, config={}, lang='ja'):
        self.lang = lang
        self._resource_cache = {}
        self._parser = str(config.get('parser', 'generated')).strip().lower()
        self._pad_to_multiple_32 = bool(config.get('pad_to_multiple_32', False))
        self._light_mode = bool(config.get('light_mode', False))
        self._mode = str(config.get('mode', 'fast')).strip().lower()
        if self._mode not in ('fast', 'accurate', 'grayscale'):
            self._mode = 'fast'
        self._retry_modes = self._parse_retry_modes(config.get('retry_modes', 'accurate,grayscale'))
        self._screen_ai_pb2 = screen_ai_pb2 or _load_screen_ai_pb2()

        if ScreenAIOCR._shared_runtime is not None:
            shared = ScreenAIOCR._shared_runtime
            self.model = shared["model"]
            self.resources_dir = shared["resources_dir"]
            self.library_path = shared.get("library_path") or shared.get("dll_path")
            self.dll_path = self.library_path
            self._library_name = shared.get("library_name", self.library_path.name if self.library_path else "")
            self._size_callback = shared["size_callback"]
            self._data_callback = shared["data_callback"]
            self._resource_cache = shared["resource_cache"]
            self.available = True
            logger.info(f'ScreenAI OCR reusing initialized runtime ({self.resources_dir})')
            return

        library_names = self._library_names_for_platform(config)
        if not library_names:
            logger.warning(f'ScreenAI OCR is not supported on platform: {sys.platform}')
            return

        library_candidates = self._resolve_library_candidates(config, library_names)
        if not library_candidates:
            ensure_screen_ai_resources(library_names)
            library_candidates = self._resolve_library_candidates(config, library_names)
        if not library_candidates:
            logger.warning('ScreenAI OCR resources not found, ScreenAI OCR will not work!')
            return

        load_errors = []
        selected_library_path = None
        for candidate_path in library_candidates:
            try:
                self.model = self._load_screen_ai_library(candidate_path)
                selected_library_path = candidate_path
                break
            except Exception as e:
                load_errors.append((candidate_path, e))

        if selected_library_path is None:
            for candidate_path, error in load_errors:
                logger.warning(f'Failed loading ScreenAI OCR library candidate "{candidate_path}": {error}')
            logger.warning('ScreenAI OCR will remain unavailable because all library candidates failed to load.')
            return

        self.library_path = selected_library_path
        self.dll_path = self.library_path
        self._library_name = self.library_path.name
        self.resources_dir = self._resolve_resource_data_dir(self.library_path.parent)

        self._configure_signatures()

        self._size_callback = ctypes.CFUNCTYPE(ctypes.c_uint32, ctypes.c_char_p)(self._get_file_content_size)
        self._data_callback = ctypes.CFUNCTYPE(
            None, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_void_p
        )(self._get_file_content)

        self.model.SetFileContentFunctions(
            ctypes.cast(self._size_callback, ctypes.c_void_p),
            ctypes.cast(self._data_callback, ctypes.c_void_p),
        )

        try:
            init_ok = bool(self.model.InitOCRUsingCallback())
        except Exception as e:
            logger.warning(f'ScreenAI OCR initialization failed: {e}')
            return

        if not init_ok:
            logger.warning('ScreenAI OCR InitOCRUsingCallback returned false.')
            return

        try:
            self.model.SetOCRLightMode(self._light_mode)
        except Exception:
            pass

        if self._parser == 'generated' and self._screen_ai_pb2 is None:
            logger.warning('ScreenAI OCR generated parser unavailable, using manual parser fallback.')
        elif self._parser == 'manual':
            logger.info('ScreenAI OCR using manual parser.')
        elif self._screen_ai_pb2 is not None:
            logger.info('ScreenAI OCR using generated protobuf parser.')
        else:
            logger.info('ScreenAI OCR using manual parser fallback.')

        self.available = True
        ScreenAIOCR._shared_runtime = {
            "model": self.model,
            "resources_dir": self.resources_dir,
            "library_path": self.library_path,
            "dll_path": self.dll_path,
            "library_name": self._library_name,
            "size_callback": self._size_callback,
            "data_callback": self._data_callback,
            "resource_cache": self._resource_cache,
        }
        logger.info(f'ScreenAI OCR ready ({self.resources_dir}, {self._library_name})')

    @staticmethod
    def _parse_retry_modes(raw_value):
        if raw_value is None:
            return []
        if isinstance(raw_value, str):
            candidates = [x.strip().lower() for x in raw_value.split(",")]
        elif isinstance(raw_value, (list, tuple)):
            candidates = [str(x).strip().lower() for x in raw_value]
        else:
            return []

        valid = []
        for candidate in candidates:
            if candidate in ('fast', 'accurate', 'grayscale'):
                valid.append(candidate)
        return valid

    def _resource_root_candidates(self, config):
        candidates = []
        configured = config.get('resources_dir') or config.get('resource_dir')
        if configured:
            configured_path = Path(configured).expanduser()
            candidates.append(configured_path)
            candidates.append(configured_path / "resources")

        # Upstream default location used by Chromium builds.
        candidates.append(Path.home() / ".config" / "screen_ai" / "resources")
        # Auto-download location.
        candidates.append(Path.home() / ".config" / "screen_ai")
        # Preferred package location.
        candidates.append(Path(__file__).resolve().parent / "screen_ai" / "resources")
        # Fallback development location.
        candidates.append(Path(__file__).resolve().parents[3] / "test" / "screen-ai" / "resources")

        resolved_candidates = []
        for candidate in candidates:
            try:
                resolved = candidate.resolve()
            except Exception:
                continue
            if resolved not in resolved_candidates:
                resolved_candidates.append(resolved)
        return resolved_candidates

    def _resolve_library_candidates(self, config, library_names):
        candidates = []
        seen = set()
        for resource_root in self._resource_root_candidates(config):
            recursive_matches = []
            try:
                for library_name in library_names:
                    recursive_matches.extend(resource_root.rglob(library_name))
            except Exception:
                recursive_matches = []

            for match in recursive_matches:
                try:
                    library_path = match.resolve()
                except Exception:
                    continue
                if not library_path.is_file():
                    continue
                if library_path in seen:
                    continue
                seen.add(library_path)
                candidates.append(library_path)

            for library_name in library_names:
                try:
                    library_path = (resource_root / library_name).resolve()
                except Exception:
                    continue
                if not library_path.is_file():
                    continue
                if library_path in seen:
                    continue
                seen.add(library_path)
                candidates.append(library_path)
        return candidates

    def _resolve_resource_data_dir(self, library_parent):
        candidates = [library_parent, library_parent / "resources"]
        for candidate in candidates:
            try:
                resolved = candidate.resolve()
            except Exception:
                continue
            if (resolved / "files_list_ocr.txt").is_file():
                return resolved
        return library_parent

    def _load_screen_ai_library(self, library_path):
        dll_mode = os.RTLD_LAZY if hasattr(os, 'RTLD_LAZY') else ctypes.DEFAULT_MODE
        return ctypes.CDLL(str(library_path), mode=dll_mode)

    def _configure_signatures(self):
        self.model.SetFileContentFunctions.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.model.InitOCRUsingCallback.restype = ctypes.c_bool
        self.model.SetOCRLightMode.argtypes = [ctypes.c_bool]
        self.model.PerformOCR.argtypes = [ctypes.POINTER(_ScreenAISkBitmap), ctypes.POINTER(ctypes.c_uint32)]
        self.model.PerformOCR.restype = ctypes.c_void_p
        self.model.FreeLibraryAllocatedCharArray.argtypes = [ctypes.c_void_p]

    def _normalize_resource_path(self, raw_path):
        normalized = raw_path.replace("\\", "/").lstrip("/").strip()
        if not normalized:
            return None
        candidate = (self.resources_dir / normalized).resolve()
        try:
            candidate.relative_to(self.resources_dir)
        except Exception:
            return None
        if not candidate.is_file():
            return None
        return normalized

    def _read_resource_bytes(self, normalized_path):
        cached = self._resource_cache.get(normalized_path)
        if cached is not None:
            return cached
        file_path = (self.resources_dir / normalized_path).resolve()
        if not file_path.is_file():
            return None
        payload = file_path.read_bytes()
        self._resource_cache[normalized_path] = payload
        return payload

    def _get_file_content_size(self, c_path):
        try:
            rel_path = self._normalize_resource_path(c_path.decode('utf-8'))
            if not rel_path:
                return 0
            payload = self._read_resource_bytes(rel_path)
            return len(payload) if payload else 0
        except Exception:
            return 0

    def _get_file_content(self, c_path, requested_size, target_ptr):
        try:
            rel_path = self._normalize_resource_path(c_path.decode('utf-8'))
            if not rel_path:
                return
            payload = self._read_resource_bytes(rel_path)
            if not payload:
                return
            size = min(len(payload), requested_size)
            ctypes.memmove(target_ptr, payload, size)
        except Exception:
            return

    def _rect_to_bbox(self, rect, img_width, img_height):
        if not rect:
            return BoundingBox(center_x=0.0, center_y=0.0, width=0.0, height=0.0, rotation_z=0.0)

        x = float(rect.get("x", 0.0))
        y = float(rect.get("y", 0.0))
        width = max(float(rect.get("width", 0.0)), 0.0)
        height = max(float(rect.get("height", 0.0)), 0.0)
        angle_deg = float(rect.get("angle", 0.0))

        if img_width <= 0 or img_height <= 0:
            return BoundingBox(center_x=0.0, center_y=0.0, width=0.0, height=0.0, rotation_z=0.0)

        angle_rad = float(np.deg2rad(angle_deg))
        center_x = x + (width / 2.0) * cos(angle_rad) - (height / 2.0) * sin(angle_rad)
        center_y = y + (width / 2.0) * sin(angle_rad) + (height / 2.0) * cos(angle_rad)

        return BoundingBox(
            center_x=center_x / float(img_width),
            center_y=center_y / float(img_height),
            width=width / float(img_width),
            height=height / float(img_height),
            rotation_z=angle_rad
        )

    def _parse_generated(self, raw_proto):
        annotation = self._screen_ai_pb2.VisualAnnotation()
        annotation.ParseFromString(raw_proto)
        lines = []
        for line_obj in annotation.lines:
            line_text = str(line_obj.utf8_string or "")
            line_text = _screen_ai_sanitize_text(line_text)
            words = []
            for word_obj in line_obj.words:
                symbols = []
                for symbol_obj in getattr(word_obj, "symbols", []):
                    symbols.append({
                        "text": _screen_ai_sanitize_text(symbol_obj.utf8_string or ""),
                        "box": {
                            "x": int(symbol_obj.bounding_box.x),
                            "y": int(symbol_obj.bounding_box.y),
                            "width": int(symbol_obj.bounding_box.width),
                            "height": int(symbol_obj.bounding_box.height),
                            "angle": float(symbol_obj.bounding_box.angle),
                        },
                        "confidence": float(getattr(symbol_obj, "confidence", 0.0)),
                    })
                words.append({
                    "text": _screen_ai_sanitize_text(word_obj.utf8_string or ""),
                    "box": {
                        "x": int(word_obj.bounding_box.x),
                        "y": int(word_obj.bounding_box.y),
                        "width": int(word_obj.bounding_box.width),
                        "height": int(word_obj.bounding_box.height),
                        "angle": float(word_obj.bounding_box.angle),
                    },
                    "has_space_after": bool(getattr(word_obj, "has_space_after", False)),
                    "confidence": float(getattr(word_obj, "confidence", 0.0)),
                    "symbols": symbols,
                })
            if not line_text and words:
                line_text = "".join(
                    w["text"] + (" " if w["has_space_after"] else "")
                    for w in words
                ).rstrip()
            if not line_text.strip():
                continue
            lines.append({
                "text": line_text,
                "box": {
                    "x": int(line_obj.bounding_box.x),
                    "y": int(line_obj.bounding_box.y),
                    "width": int(line_obj.bounding_box.width),
                    "height": int(line_obj.bounding_box.height),
                    "angle": float(line_obj.bounding_box.angle),
                },
                "language": str(line_obj.language or ""),
                "confidence": float(getattr(line_obj, "confidence", 0.0)),
                "words": words,
            })
        return lines

    def _expand_line_words(self, line_data):
        raw_words = list(line_data.get("words", []) or [])
        if not raw_words:
            return []

        line_text = _screen_ai_sanitize_text(line_data.get("text", ""))
        joined_words = ''.join(_screen_ai_sanitize_text(w.get("text", "")) for w in raw_words).replace(' ', '')
        normalized_line = line_text.replace(' ', '')

        total_symbol_count = sum(len([s for s in (w.get("symbols") or []) if _screen_ai_sanitize_text(s.get("text", ""))]) for w in raw_words)
        use_symbols = total_symbol_count > 1 and (
            len(raw_words) <= 1 or
            (_screen_ai_contains_cjk(normalized_line) and joined_words == normalized_line)
        )

        if not use_symbols:
            return raw_words

        expanded_words = []
        for raw_word in raw_words:
            symbol_entries = []
            for symbol in raw_word.get("symbols", []) or []:
                symbol_text = _screen_ai_sanitize_text(symbol.get("text", ""))
                if not symbol_text:
                    continue
                symbol_entries.append({
                    "text": symbol_text,
                    "box": symbol.get("box") or raw_word.get("box"),
                    "has_space_after": False,
                    "confidence": symbol.get("confidence"),
                })
            if symbol_entries:
                if raw_word.get("has_space_after"):
                    symbol_entries[-1]["has_space_after"] = True
                expanded_words.extend(symbol_entries)
            else:
                expanded_words.append(raw_word)
        return expanded_words

    def _to_generic_result(self, raw_proto, img_width, img_height):
        use_generated = self._parser != 'manual' and self._screen_ai_pb2 is not None
        if use_generated:
            try:
                parsed_lines = self._parse_generated(raw_proto)
            except Exception:
                parsed_lines = _screen_ai_parse_visual_annotation_manual(raw_proto)
        else:
            parsed_lines = _screen_ai_parse_visual_annotation_manual(raw_proto)

        parsed_lines.sort(
            key=lambda line: (
                (line.get("box") or {}).get("y", 10**9),
                (line.get("box") or {}).get("x", 10**9),
            )
        )

        lines = []
        for line_data in parsed_lines:
            words = []
            for word_data in self._expand_line_words(line_data):
                word_text = _screen_ai_sanitize_text(word_data.get("text", ""))
                if not word_text:
                    continue
                words.append(
                    Word(
                        text=word_text,
                        bounding_box=self._rect_to_bbox(word_data.get("box"), img_width, img_height),
                        separator=' ' if word_data.get("has_space_after") else None
                    )
                )

            line_text = _screen_ai_sanitize_text(line_data.get("text", ""))
            if not line_text and words:
                line_text = ''.join(w.text + (w.separator or '') for w in words).rstrip()

            line = Line(
                text=line_text,
                bounding_box=self._rect_to_bbox(line_data.get("box"), img_width, img_height),
                words=words
            )
            lines.append(line)

        if lines:
            paragraph_bbox = merge_bounding_boxes(lines, rotated=True)
            paragraphs = [Paragraph(bounding_box=paragraph_bbox, lines=lines)]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def _pad_to_multiple(self, image, multiple=32, fill='white'):
        pad_right = (multiple - (image.width % multiple)) % multiple
        pad_bottom = (multiple - (image.height % multiple)) % multiple
        if pad_right or pad_bottom:
            return ImageOps.expand(image, border=(0, 0, pad_right, pad_bottom), fill=fill)
        return image

    def _preprocess(self, img, mode='fast'):
        # No enhancement preprocessing: only guarantee RGBA buffer layout for native call.
        if img.mode != 'RGBA':
            return img.convert('RGBA')
        return img
        # Flatten alpha to avoid transparent composites causing empty OCR responses.
        # if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
        #     base = Image.new('RGBA', img.size, (255, 255, 255, 255))
        #     base.alpha_composite(img.convert('RGBA'))
        #     rgb = base.convert('RGB')
        # else:
        #     rgb = img.convert('RGB')

        # if mode == 'accurate':
        #     processed = rgb.filter(ImageFilter.UnsharpMask(radius=1.2, percent=150, threshold=2))
        # elif mode == 'grayscale':
        #     gray = ImageOps.grayscale(rgb)
        #     gray = ImageOps.autocontrast(gray, cutoff=1)
        #     processed = gray.filter(ImageFilter.UnsharpMask(radius=1.0, percent=120, threshold=2)).convert('RGB')
        # else:
        #     processed = rgb

        # if self._pad_to_multiple_32:
        #     processed = self._pad_to_multiple(processed, multiple=32, fill='white')
        # return processed.convert('RGBA')

    def _perform_ocr(self, processed):
        pixel_buffer = ctypes.create_string_buffer(processed.tobytes())

        bitmap = _ScreenAISkBitmap()
        bitmap.fPixelRef = None
        bitmap.fPixmap.fPixels = ctypes.cast(pixel_buffer, ctypes.c_void_p)
        bitmap.fPixmap.fRowBytes = processed.width * 4
        bitmap.fPixmap.fInfo.fColorInfo.fColorType = 4  # kRGBA_8888
        bitmap.fPixmap.fInfo.fColorInfo.fAlphaType = 1  # kOpaque
        bitmap.fPixmap.fInfo.fDimensions.fWidth = processed.width
        bitmap.fPixmap.fInfo.fDimensions.fHeight = processed.height
        bitmap.fFlags = 0

        output_length = ctypes.c_uint32(0)
        result_ptr = self.model.PerformOCR(ctypes.byref(bitmap), ctypes.byref(output_length))
        if not result_ptr or output_length.value == 0:
            return None

        try:
            return ctypes.string_at(result_ptr, output_length.value)
        finally:
            self.model.FreeLibraryAllocatedCharArray(result_ptr)

    def __call__(self, img, furigana_filter_sensitivity=0):
        try:
            furigana_filter_sensitivity = int(furigana_filter_sensitivity or 0)
        except (TypeError, ValueError):
            furigana_filter_sensitivity = 0

        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')
        if not self.available:
            if is_path:
                img.close()
            return (False, 'ScreenAI OCR is not available.')

        modes_to_try = [self._mode]
        for mode in self._retry_modes:
            if mode not in modes_to_try:
                modes_to_try.append(mode)

        raw_proto = None
        processed = None
        used_mode = None
        for mode in modes_to_try:
            processed = self._preprocess(img, mode=mode)
            raw_proto = self._perform_ocr(processed)
            if raw_proto:
                used_mode = mode
                break

        if raw_proto is None or processed is None:
            if is_path:
                img.close()
            return (True, '', [], [], None, None)

        if used_mode and used_mode != self._mode:
            logger.debug(f'ScreenAI OCR succeeded using fallback mode "{used_mode}"')

        ocr_result = self._to_generic_result(raw_proto, processed.width, processed.height)
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity, prefer_axis_spacing=True)

        if is_path:
            img.close()
        return x


class OneOCR:
    name = 'oneocr'
    readable_name = 'OneOCR'
    key = 'z'
    config_entry = 'oneocr'
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={}, lang='ja', get_furigana_sens_from_file=True):
        import regex
        self.initial_lang = lang
        self.regex = get_regex(lang)
        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}]')
        self.get_furigana_sens_from_file = get_furigana_sens_from_file
        if sys.platform == 'win32':
            if int(platform.release()) < 10:
                logger.warning('OneOCR is not supported on Windows older than 10!')
            elif 'oneocr' not in sys.modules:
                logger.warning('oneocr not available, OneOCR will not work!')
            else:
                try:
                    self.model = oneocr.OcrEngine()
                except RuntimeError as e:
                    logger.warning(f"{e}, OneOCR will not work!")
                else:
                    self.available = True
                    logger.background('OneOCR ready')
        else:
            try:
                self.url = config['url']
                self.available = True
                logger.background('OneOCR ready')
            except:
                logger.warning('Error reading URL from config, OneOCR will not work!')
    
    def get_regex(self, lang):
        if lang == "ja":
            self.regex = re.compile(r'[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]')
        elif lang == "zh":
            self.regex = re.compile(r'[\u4E00-\u9FFF]')
        elif lang == "ko":
            self.regex = re.compile(r'[\uAC00-\uD7AF]')
        elif lang == "ar":
            self.regex = re.compile(r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]')
        elif lang == "ru":
            self.regex = re.compile(r'[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F\u1C80-\u1C8F]')
        elif lang == "el":
            self.regex = re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF]')
        elif lang == "he":
            self.regex = re.compile(r'[\u0590-\u05FF\uFB1D-\uFB4F]')
        elif lang == "th":
            self.regex = re.compile(r'[\u0E00-\u0E7F]')
        else:
            self.regex = re.compile(
            r'[a-zA-Z\u00C0-\u00FF\u0100-\u017F\u0180-\u024F\u0250-\u02AF\u1D00-\u1D7F\u1D80-\u1DBF\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\uAB30-\uAB6F]')

    def _convert_bbox(self, rect, img_width, img_height):
        return quad_to_bounding_box(
            rect['x1'], rect['y1'],
            rect['x2'], rect['y2'],
            rect['x3'], rect['y3'],
            rect['x4'], rect['y4'],
            img_width, img_height
        )

    def _to_generic_result(self, response, img_width, img_height, og_img_width, og_img_height):
        lines = []
        for l in response.get('lines', []):
            words = []
            for i, w in enumerate(l.get('words', [])):
                word = Word(
                    text=w.get('text', ''),
                    bounding_box=self._convert_bbox(w['bounding_rect'], img_width, img_height)
                )
                words.append(word)

            line = Line(
                text=l.get('text', ''),
                bounding_box=self._convert_bbox(l['bounding_rect'], img_width, img_height),
                words=words
            )
            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=og_img_width, height=og_img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0, return_coords=False, multiple_crop_coords=False, return_one_box=True, return_dict=False):
        lang = get_ocr_language()
        if self.get_furigana_sens_from_file:
            furigana_filter_sensitivity = get_furigana_filter_sensitivity()
        
        if lang != self.initial_lang:
            self.initial_lang = lang
            self.regex = get_regex(lang)

        img, is_path = input_to_pil_image(img)
        if img.width < 51 or img.height < 51:
            new_width = max(img.width, 51)
            new_height = max(img.height, 51)
            new_img = Image.new("RGBA", (new_width, new_height), (0, 0, 0, 0))
            new_img.paste(img, ((new_width - img.width) // 2, (new_height - img.height) // 2))
            img = new_img
        if not img:
            return (False, 'Invalid image provided')

        if sys.platform == 'win32':
            img_processed = self._preprocess_windows(img)
            img_width, img_height = img_processed.size
            try:
                raw_res = self.model.recognize_pil(img_processed)
            except RuntimeError as e:
                return (False, e)
        else:
            img_processed, img_width, img_height = self._preprocess_notwindows(img)
            try:
                res = curl_cffi.post(self.url, data=img_processed, timeout=3)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')

            if res.status_code != 200:
                return (False, 'Unknown error!')

            raw_res = res.json()

        if 'error' in raw_res:
            return (False, raw_res['error'])

        ocr_result = self._to_generic_result(raw_res, img_width, img_height, img.width, img.height)
        
        # Use common converter which handles filtering
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity, prefer_axis_spacing=True)

        if is_path:
            img.close()
        return x

    def _preprocess_windows(self, img):
        min_pixel_size = 50
        max_pixel_size = 10000

        if any(x < min_pixel_size for x in img.size):
            resize_factor = max(min_pixel_size / img.width, min_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        if any(x > max_pixel_size for x in img.size):
            resize_factor = min(max_pixel_size / img.width, max_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        return img

    def _preprocess_notwindows(self, img):
        img = self._preprocess_windows(img)
        return pil_image_to_bytes(img, png_compression=1), img.width, img.height
    

class MLKitOCR:
    name = 'mlkitocr'
    readable_name = 'MLKit OCR'
    key = 'x'
    config_entry = 'mlkitocr'
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=True
    )

    def __init__(self, config={}, lang='ja', get_furigana_sens_from_file=True):
        self.initial_lang = lang
        self.regex = get_regex(lang)
        self.get_furigana_sens_from_file = get_furigana_sens_from_file
        self.script_override = str(config.get('script', '')).strip().lower() if config else ''
        self.timeout = float(config.get('timeout', 3)) if config else 3.0
        self.use_raw_upload = self._to_bool(config.get('raw_upload'), True) if config else True
        self.include_words = self._to_bool(config.get('include_words'), True) if config else True
        self.adaptive_jpeg = self._to_bool(config.get('adaptive_jpeg'), True) if config else True
        self.upload_format = str(config.get('upload_format', 'jpeg')).strip().lower() if config else 'jpeg'
        self.jpeg_threshold_bytes = int(config.get('jpeg_threshold_bytes', 450000)) if config else 450000
        self.jpeg_quality = int(config.get('jpeg_quality', 88)) if config else 88
        self.jpeg_min_savings_ratio = float(config.get('jpeg_min_savings_ratio', 0.80)) if config else 0.80
        url = ''
        if config:
            url = str(config.get('url', '')).strip()
        self.url = url or 'http://192.168.1.178:8550/ocr'
        import threading
        self._thread_local = threading.local()
        self.available = True
        logger.background(f'MLKit OCR ready ({self.url})')

    @staticmethod
    def _to_bool(value, default=False):
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            return value.strip().lower() in ('1', 'true', 'yes', 'on')
        return default

    @staticmethod
    def _try_float(value):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _map_script(self, lang):
        if self.script_override:
            return self.script_override

        mapping = {
            'ja': 'japanese',
            'zh': 'chinese',
            'ko': 'korean',
            'hi': 'devanagari',
            'mr': 'devanagari',
            'sa': 'devanagari',
        }
        return mapping.get(lang, 'latin')

    @staticmethod
    def _to_float(value, default=0.0):
        try:
            return float(value)
        except (TypeError, ValueError):
            return float(default)

    def _bbox_from_box(self, box, img_width, img_height):
        if isinstance(box, (list, tuple)) and len(box) >= 4:
            x = self._to_float(box[0])
            y = self._to_float(box[1])
            w = max(self._to_float(box[2]), 0.0)
            h = max(self._to_float(box[3]), 0.0)
            return rectangle_to_bounding_box(x, y, x + w, y + h, img_width, img_height)
        if isinstance(box, dict):
            x = self._to_float(box.get('x'))
            y = self._to_float(box.get('y'))
            w = max(self._to_float(box.get('width')), 0.0)
            h = max(self._to_float(box.get('height')), 0.0)
            return rectangle_to_bounding_box(x, y, x + w, y + h, img_width, img_height)
        return rectangle_to_bounding_box(0, 0, 0, 0, img_width, img_height)

    def _to_generic_result(self, response, img_width, img_height, og_img_width, og_img_height):
        lines = []
        for line_data in response.get('lines', []):
            words = []
            for word_data in line_data.get('words', []):
                words.append(Word(
                    text=str(word_data.get('text', '') or ''),
                    bounding_box=self._bbox_from_box(word_data.get('box'), img_width, img_height)
                ))

            line_text = str(line_data.get('text', '') or '')
            if not line_text and words:
                line_text = ''.join(word.text for word in words)
            if not line_text and not words:
                continue

            lines.append(Line(
                text=line_text,
                bounding_box=self._bbox_from_box(line_data.get('box'), img_width, img_height),
                words=words
            ))

        paragraphs = []
        if lines:
            paragraphs.append(Paragraph(
                bounding_box=merge_bounding_boxes(lines),
                lines=lines
            ))

        return OcrResult(
            image_properties=ImageProperties(width=og_img_width, height=og_img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def _build_request_url(self, script=None):
        parsed = urlparse(self.url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if script:
            query['script'] = [script]
        query['schema'] = ['v2']
        if not self.include_words:
            query['words'] = ['0']
        elif 'words' in query:
            del query['words']
        return parsed._replace(query=urlencode(query, doseq=True)).geturl()

    def _encode_request_image(self, img):
        if self.upload_format in ('jpg', 'jpeg'):
            jpeg_bytes = pil_image_to_bytes(img, 'jpeg', jpeg_quality=self.jpeg_quality, optimize=True)
            return jpeg_bytes, 'image/jpeg', 'jpeg'
        if self.upload_format == 'png':
            png_bytes = pil_image_to_bytes(img, png_compression=1)
            return png_bytes, 'image/png', 'png'

        png_bytes = pil_image_to_bytes(img, png_compression=1)
        if not self.adaptive_jpeg:
            return png_bytes, 'image/png', 'png'
        if len(png_bytes) < self.jpeg_threshold_bytes:
            return png_bytes, 'image/png', 'png'

        jpeg_bytes = pil_image_to_bytes(img, 'jpeg', jpeg_quality=self.jpeg_quality, optimize=True)
        if len(jpeg_bytes) <= len(png_bytes) * self.jpeg_min_savings_ratio:
            return jpeg_bytes, 'image/jpeg', 'jpeg'

        return png_bytes, 'image/png', 'png'

    def _get_requests_session(self):
        session = getattr(self._thread_local, 'session', None)
        if session is None:
            session = curl_cffi.Session()
            self._thread_local.session = session
        return session

    def __call__(self, img, furigana_filter_sensitivity=0, return_coords=False, multiple_crop_coords=False, return_one_box=True, return_dict=False):
        lang = get_ocr_language()
        if self.get_furigana_sens_from_file:
            furigana_filter_sensitivity = get_furigana_filter_sensitivity()

        if lang != self.initial_lang:
            self.initial_lang = lang
            self.regex = get_regex(lang)

        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')
        source_img_to_close = img if is_path else None
        try:
            if img.width < 51 or img.height < 51:
                new_width = max(img.width, 51)
                new_height = max(img.height, 51)
                new_img = Image.new("RGBA", (new_width, new_height), (0, 0, 0, 0))
                new_img.paste(img, ((new_width - img.width) // 2, (new_height - img.height) // 2))
                img = new_img

            img_processed, content_type, upload_format = self._encode_request_image(img)
            script = self._map_script(lang)
            request_url = self._build_request_url(script if self.use_raw_upload else None)

            request_start = time.perf_counter()
            requests_session = self._get_requests_session()
            try:
                request_headers = {
                    'content-type': content_type,
                    'connection': 'keep-alive',
                    # Prevent 100-continue handshake latency on small LAN uploads.
                    'expect': ''
                }
                if self.use_raw_upload:
                    response = requests_session.post(
                        request_url,
                        data=img_processed,
                        headers=request_headers,
                        timeout=self.timeout
                    )
                else:
                    mime = curl_cffi.CurlMime()
                    mime.addpart(name='image', filename=f'image.{upload_format}', content_type=content_type, data=img_processed)
                    mime.addpart(name='script', data=script)
                    if not self.include_words:
                        mime.addpart(name='words', data='0')
                    response = requests_session.post(request_url, multipart=mime, headers=request_headers, timeout=self.timeout)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')
            except Exception as e:
                return (False, str(e))
            response_roundtrip_ms = (time.perf_counter() - request_start) * 1000.0

            if response.status_code != 200:
                return (False, f'HTTP {response.status_code}')

            try:
                raw_res = response.json()
            except Exception:
                return (False, 'Invalid server response!')

            if not isinstance(raw_res, dict):
                return (False, 'Invalid server response!')

            timing_data = raw_res.get('timing') if isinstance(raw_res.get('timing'), dict) else {}
            ocr_processing_ms = self._try_float(timing_data.get('ocr_ms'))
            decode_ms = self._try_float(timing_data.get('decode_ms'))
            result_build_ms = self._try_float(timing_data.get('build_ms'))
            server_total_ms = self._try_float(timing_data.get('server_ms'))
            request_read_ms = self._try_float(raw_res.get('request_read_ms'))
            server_handle_ms = self._try_float(raw_res.get('server_handle_ms'))
            payload_kb = len(img_processed) / 1024.0
            if ocr_processing_ms is not None:
                def _fmt_metric(value):
                    return f"{value:.2f}" if value is not None else "n/a"

                comparison_server_ms = server_handle_ms if server_handle_ms is not None else (server_total_ms if server_total_ms is not None else ocr_processing_ms)
                network_overhead_ms = response_roundtrip_ms - comparison_server_ms
                # logger.info(
                #     f"script={script}, "
                #     f"MLKit OCR timing: processing={_fmt_metric(ocr_processing_ms)} ms, "
                #     f"decode={_fmt_metric(decode_ms)} ms, "
                #     f"read={_fmt_metric(request_read_ms)} ms, "
                #     f"build={_fmt_metric(result_build_ms)} ms, "
                #     f"server_total={_fmt_metric(server_total_ms)} ms, "
                #     f"server_handle={_fmt_metric(server_handle_ms)} ms, "
                #     f"round_trip={response_roundtrip_ms:.2f} ms, "
                #     f"outside_server={network_overhead_ms:.2f} ms, "
                #     f"upload={payload_kb:.1f} KB, format={upload_format}"
                # )

            if 'error' in raw_res:
                return (False, str(raw_res.get('error')))

            img_width = int(raw_res.get('image_width') or img.width)
            img_height = int(raw_res.get('image_height') or img.height)
            ocr_result = self._to_generic_result(raw_res, img_width, img_height, img.width, img.height)
            x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity, prefer_axis_spacing=True)
            return x
        finally:
            if source_img_to_close:
                source_img_to_close.close()


class MeikiOCR:
    name = 'meikiocr'
    readable_name = 'MeikiOCR'
    key = 'k'
    config_entry = None
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={}, lang='ja', get_furigana_sens_from_file=True):
        import regex
        self.initial_lang = lang
        self.regex = get_regex(lang)
        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}]')
        self.get_furigana_sens_from_file = get_furigana_sens_from_file
        self.model = SharedMeikiOCRModel.get_model(force_cpu=get_config().vad.use_cpu_for_inference_v2)
        self.available = self.model is not None
        if self.available:
            logger.info('MeikiOCR ready')
        else:
            init_error = SharedMeikiOCRModel.get_init_error()
            if init_error:
                logger.warning(f'{init_error}, MeikiOCR will not work!')
            else:
                logger.warning('meikiocr not available, MeikiOCR will not work!')

    def get_regex(self, lang):
        if lang == "ja":
            self.regex = re.compile(r'[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]')
        elif lang == "zh":
            self.regex = re.compile(r'[\u4E00-\u9FFF]')
        elif lang == "ko":
            self.regex = re.compile(r'[\uAC00-\uD7AF]')
        elif lang == "ar":
            self.regex = re.compile(r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]')
        elif lang == "ru":
            self.regex = re.compile(r'[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F\u1C80-\u1C8F]')
        elif lang == "el":
            self.regex = re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF]')
        elif lang == "he":
            self.regex = re.compile(r'[\u0590-\u05FF\uFB1D-\uFB4F]')
        elif lang == "th":
            self.regex = re.compile(r'[\u0E00-\u0E7F]')
        else:
            self.regex = re.compile(
            r'[a-zA-Z\u00C0-\u00FF\u0100-\u017F\u0180-\u024F\u0250-\u02AF\u1D00-\u1D7F\u1D80-\u1DBF\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\uAB30-\uAB6F]')

    def __call__(self, img, furigana_filter_sensitivity=0, return_coords=False, multiple_crop_coords=False, return_one_box=True, return_dict=False):
        lang = get_ocr_language()
        if self.get_furigana_sens_from_file:
            furigana_filter_sensitivity = get_furigana_filter_sensitivity()
        else:
            furigana_filter_sensitivity = furigana_filter_sensitivity
        if lang != self.initial_lang:
            self.initial_lang = lang
            self.regex = get_regex(lang)
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')
        crop_coords = None
        crop_coords_list = []
        ocr_resp = ''
        
        try:
            # Convert PIL image to numpy array for meikiocr
            # OLD WAY OF COLOR SHIFTING (was causing issues)
            # image_np = np.array(img.convert('RGB'))[:, :, ::-1]
            
            # # convert back to PIL and save for testing
            
            image_np = np.array(img.convert('RGB'))
            
            # new_img = Image.fromarray(image_np)
            # if os.path.exists(os.path.expanduser("~/GSM/temp")):
            #         new_img.save(os.path.join(os.path.expanduser("~/GSM/temp"), 'meikiocr_input.png'))
            
            # Run meikiocr
            read_results = self.model.run_ocr(image_np, punct_conf_factor=0.2)
            
            # Convert meikiocr response to OneOCR format
            ocr_resp = self._convert_meikiocr_to_oneocr_format(read_results, img.width, img.height)
            
            if os.path.exists(os.path.expanduser("~/GSM/temp")):
                with open(os.path.join(os.path.expanduser("~/GSM/temp"), 'meikiocr_response.json'), 'w', encoding='utf-8') as f:
                    json.dump(ocr_resp, f, indent=4, ensure_ascii=False)
            
            filtered_lines = [line for line in ocr_resp['lines'] if self.regex.search(line['text'])]
            x_coords = [line['bounding_rect'][f'x{i}'] for line in filtered_lines for i in range(1, 5)]
            y_coords = [line['bounding_rect'][f'y{i}'] for line in filtered_lines for i in range(1, 5)]
            if x_coords and y_coords:
                crop_coords = (min(x_coords) - 5, min(y_coords) - 5, max(x_coords) + 5, max(y_coords) + 5)
            
            res = ''
            skipped = []
            if furigana_filter_sensitivity > 0:
                passing_lines = []
                for line in filtered_lines:
                    line_x1, line_x2, line_x3, line_x4 = line['bounding_rect']['x1'], line['bounding_rect']['x2'], \
                        line['bounding_rect']['x3'], line['bounding_rect']['x4']
                    line_y1, line_y2, line_y3, line_y4 = line['bounding_rect']['y1'], line['bounding_rect']['y2'], \
                        line['bounding_rect']['y3'], line['bounding_rect']['y4']
                    line_width = max(line_x2 - line_x1, line_x3 - line_x4)
                    line_height = max(line_y3 - line_y1, line_y4 - line_y2)
                    
                    # Check if the line passes the size filter
                    if line_width > furigana_filter_sensitivity and line_height > furigana_filter_sensitivity:
                        # Line passes - include line for text assembly
                        passing_lines.append(line)
                    else:
                        skipped.extend(char for char in line['text'])
                filtered_lines = passing_lines
                res = build_spatial_text(
                    [line_dict_to_spatial_entry(line) for line in passing_lines],
                    blank_line_token='BLANK_LINE'
                )
                return_resp = {'text': res, 'text_angle': ocr_resp['text_angle'], 'lines': passing_lines}
                # logger.info(
                #     f"Skipped {len(skipped)} chars due to furigana filter sensitivity: {furigana_filter_sensitivity}")
                # widths, heights = [], []
                # for line in ocr_resp['lines']:
                #     for word in line['words']:
                #         if self.kana_kanji_regex.search(word['text']) is None:
                #             continue
                #         # x1, x2, x3, x4 = line['bounding_rect']['x1'], line['bounding_rect']['x2'], \
                #         # line['bounding_rect']['x3'], line['bounding_rect']['x4']
                #         # y1, y2, y3, y4 = line['bounding_rect']['y1'], line['bounding_rect']['y2'], \
                #         # line['bounding_rect']['y3'], line['bounding_rect']['y4']
                #         x1, x2, x3, x4 = word['bounding_rect']['x1'], word['bounding_rect']['x2'], \
                #         word['bounding_rect']['x3'], word['bounding_rect']['x4']
                #         y1, y2, y3, y4 = word['bounding_rect']['y1'], word['bounding_rect']['y2'], \
                #         word['bounding_rect']['y3'], word['bounding_rect']['y4']
                #         widths.append(max(x2 - x1, x3 - x4))
                #         heights.append(max(y2 - y1, y3 - y4))
                # 
                # 
                # max_width = max(sorted(widths)[:-max(1, len(widths) // 10)]) if len(widths) > 1 else 0
                # max_height = max(sorted(heights)[:-max(1, len(heights) // 10)]) if len(heights) > 1 else 0
                # 
                # required_width = max_width * furigana_filter_sensitivity
                # required_height = max_height * furigana_filter_sensitivity
                # for line in ocr_resp['lines']:
                #     for word in line['words']:
                #         x1, x2, x3, x4 = word['bounding_rect']['x1'], word['bounding_rect']['x2'], \
                #         word['bounding_rect']['x3'], word['bounding_rect']['x4']
                #         y1, y2, y3, y4 = word['bounding_rect']['y1'], word['bounding_rect']['y2'], \
                #         word['bounding_rect']['y3'], word['bounding_rect']['y4']
                #         width = max(x2 - x1, x3 - x4)
                #         height = max(y2 - y1, y3 - y4)
                #         if furigana_filter_sensitivity == 0 or width > required_width or height > required_height:
                #             res += word['text']
                #         else:
                #             continue
                #     res += '\n'
            else:
                res = build_spatial_text(
                    [line_dict_to_spatial_entry(line) for line in filtered_lines],
                    blank_line_token='BLANK_LINE'
                )
                return_resp = dict(ocr_resp)
                return_resp['text'] = res
                
            for line in filtered_lines:
                crop_coords_list.append(
                    (line['bounding_rect']['x1'] - 5, line['bounding_rect']['y1'] - 5,
                        line['bounding_rect']['x3'] + 5, line['bounding_rect']['y3'] + 5))

        except RuntimeError as e:
            return (False, str(e))
        except Exception as e:
            return (False, f'MeikiOCR error: {str(e)}')

        x = (True, res, 
            filtered_lines if return_coords else None,
            crop_coords_list,
            crop_coords if return_one_box else None,
            return_resp if return_dict else None)
        
        if is_path:
            img.close()
        return x

    def _convert_meikiocr_to_oneocr_format(self, meikiocr_results, img_width, img_height):
        """
        Convert meikiocr output format to match OneOCR format.
        
        meikiocr returns: [{'text': 'line text', 'chars': [{'char': '字', 'bbox': [x1, y1, x2, y2], 'conf': 0.9}, ...]}, ...]
        
        OneOCR format expected:
        {
            'text': 'full text',
            'text_angle': 0,
            'lines': [
                {
                    'text': 'line text',
                    'bounding_rect': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'x3': x3, 'y3': y3, 'x4': x4, 'y4': y4},
                    'words': [{'text': 'char', 'bounding_rect': {...}}, ...]
                },
                ...
            ]
        }
        """
        lines = []
        
        for line_result in meikiocr_results:
            line_text = line_result.get('text', '')
            char_results = line_result.get('chars', [])
            
            if not line_text or not char_results:
                continue
            
            # Convert characters and calculate line bbox from char bboxes
            words = []
            all_x_coords = []
            all_y_coords = []
            
            for char_info in char_results:
                char_text = char_info.get('char', '')
                char_bbox = char_info.get('bbox', [0, 0, 0, 0])
                
                cx1, cy1, cx2, cy2 = char_bbox
                all_x_coords.extend([cx1, cx2])
                all_y_coords.extend([cy1, cy2])
                
                char_bounding_rect = {
                    'x1': cx1, 'y1': cy1,
                    'x2': cx2, 'y2': cy1,
                    'x3': cx2, 'y3': cy2,
                    'x4': cx1, 'y4': cy2
                }
                
                words.append({
                    'text': char_text,
                    'bounding_rect': char_bounding_rect
                })
            
            # Calculate line bounding box from all character bboxes
            if all_x_coords and all_y_coords:
                x1 = min(all_x_coords)
                y1 = min(all_y_coords)
                x2 = max(all_x_coords)
                y2 = max(all_y_coords)
                
                line_bounding_rect = {
                    'x1': x1, 'y1': y1,
                    'x2': x2, 'y2': y1,
                    'x3': x2, 'y3': y2,
                    'x4': x1, 'y4': y2
                }
            else:
                line_bounding_rect = {
                    'x1': 0, 'y1': 0,
                    'x2': 0, 'y2': 0,
                    'x3': 0, 'y3': 0,
                    'x4': 0, 'y4': 0
                }
            
            lines.append({
                'text': line_text,
                'bounding_rect': line_bounding_rect,
                'words': words
            })
        
        full_text = build_spatial_text(
            [line_dict_to_spatial_entry(line) for line in lines],
            blank_line_token='BLANK_LINE'
        )
        
        return {
            'text': full_text,
            'text_angle': 0,
            'lines': lines
        }

    def _preprocess(self, img):
        return pil_image_to_bytes(img, png_compression=1)


class AzureImageAnalysis:
    name = 'azure'
    readable_name = 'Azure Image Analysis'
    key = 'v'
    config_entry = 'azure'
    available = False
    local = False
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={}, lang='ja'):
        if 'azure.ai.vision.imageanalysis' not in sys.modules:
            logger.warning('azure-ai-vision-imageanalysis not available, Azure Image Analysis will not work!')
        else:
            logger.info(f'Parsing Azure credentials')
            try:
                self.client = ImageAnalysisClient(config['endpoint'], AzureKeyCredential(config['api_key']))
                self.available = True
                logger.info('Azure Image Analysis ready')
            except:
                logger.warning('Error parsing Azure credentials, Azure Image Analysis will not work!')

    def _convert_bbox(self, rect, img_width, img_height):
        return quad_to_bounding_box(
            rect[0]['x'], rect[0]['y'],
            rect[1]['x'], rect[1]['y'],
            rect[2]['x'], rect[2]['y'],
            rect[3]['x'], rect[3]['y'],
            img_width, img_height
        )

    def _to_generic_result(self, read_result, img_width, img_height):
        paragraphs = []
        if read_result.read:
            for block in read_result.read.blocks:
                lines = []
                for azure_line in block.lines:
                    l_bbox = self._convert_bbox(azure_line.bounding_polygon, img_width, img_height)

                    words = []
                    for azure_word in azure_line.words:
                        w_bbox = self._convert_bbox(azure_word.bounding_polygon, img_width, img_height)
                        word = Word(
                            text=azure_word.text,
                            bounding_box=w_bbox
                        )
                        words.append(word)

                    line = Line(
                        bounding_box=l_bbox,
                        words=words,
                        text=azure_line.text
                    )
                    lines.append(line)

                p_bbox = merge_bounding_boxes(lines)
                paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
                paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        try:
            read_result = self.client.analyze(image_data=self._preprocess(img), visual_features=[VisualFeatures.READ])
        except ServiceRequestError:
            return (False, 'Connection error!')
        except:
            return (False, 'Unknown error!')

        ocr_result = self._to_generic_result(read_result, img.width, img.height)
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        min_pixel_size = 50
        max_pixel_size = 10000

        if any(x < min_pixel_size for x in img.size):
            resize_factor = max(50 / img.width, 50 / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        if any(x > max_pixel_size for x in img.size):
            resize_factor = min(max_pixel_size / img.width, max_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        return pil_image_to_bytes(img)

class EasyOCR:
    name = 'easyocr'
    readable_name = 'EasyOCR'
    key = 'e'
    config_entry = 'easyocr'
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={'gpu': True}, lang='ja'):
        if 'easyocr' not in sys.modules:
            logger.warning('easyocr not available, EasyOCR will not work!')
        else:
            logger.info('Loading EasyOCR model')
            gpu = config.get('gpu', True)
            logging.getLogger('easyocr.easyocr').setLevel(logging.ERROR)
            self.model = easyocr.Reader(['ja','en'], gpu=gpu)
            self.available = True
            logger.info('EasyOCR ready')

    def _convert_bbox(self, rect, img_width, img_height):
        (x1, y1), (x2, y2), (x3, y3), (x4, y4) = [(float(x), float(y)) for x, y in rect]
        return quad_to_bounding_box(x1, y1, x2, y2, x3, y3, x4, y4, img_width, img_height)

    def _to_generic_result(self, response, img_width, img_height):
        lines = []

        for detection in response:
            quad_coords = detection[0]
            text = detection[1]

            bbox = self._convert_bbox(quad_coords, img_width, img_height)
            word = Word(text=text, bounding_box=bbox)
            line = Line(bounding_box=bbox, words=[word], text=text)
            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        read_results = self.model.readtext(self._preprocess(img))
        ocr_result = self._to_generic_result(read_results, img.width, img.height)
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_numpy_array(img)

class RapidOCR:
    name = 'rapidocr'
    readable_name = 'RapidOCR'
    key = 'r'
    config_entry = 'rapidocr'
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={}, lang='ja'):
        if 'rapidocr_onnxruntime' not in sys.modules:
            logger.warning('rapidocr_onnxruntime not available, RapidOCR will not work!')
        else:
            logger.info('Loading RapidOCR model')
            high_accuracy_detection = config.get('high_accuracy_detection', False)
            high_accuracy_recognition = config.get('high_accuracy_recognition', True)
            lang_rec = self.language_to_model_language(lang)
            self.model = ROCR(params={
                'Det.engine_type': EngineType.ONNXRUNTIME,
                'Det.lang_type': LangDet.CH,
                'Det.model_type': ModelType.SERVER if high_accuracy_detection else ModelType.MOBILE,
                'Det.ocr_version': OCRVersion.PPOCRV5,
                'Rec.engine_type': EngineType.ONNXRUNTIME,
                'Rec.lang_type': lang_rec,
                'Rec.model_type': ModelType.SERVER if high_accuracy_recognition else ModelType.MOBILE,
                'Rec.ocr_version': OCRVersion.PPOCRV5,
                'Global.log_level': 'error'
            })
            self.available = True
            logger.info('RapidOCR ready')
            
    def language_to_model_language(self, language):
        if language == 'ja':
            return LangRec.CH
        if language == 'zh':
            return LangRec.CH
        elif language == 'ko':
            return LangRec.KOREAN
        elif language == 'ru':
            return LangRec.ESLAV
        elif language == 'el':
            return LangRec.EL
        elif language == 'th':
            return LangRec.TH
        else:
            return LangRec.LATIN

    def _convert_bbox(self, rect, img_width, img_height):
        (x1, y1), (x2, y2), (x3, y3), (x4, y4) = [(float(x), float(y)) for x, y in rect]
        return quad_to_bounding_box(x1, y1, x2, y2, x3, y3, x4, y4, img_width, img_height)

    def _to_generic_result(self, response, img_width, img_height):
        lines = []
        if response and response[0]:
             # Check if response matches expectations: (bboxes, texts, scores) or similar
             # RapidOCR usually returns list of [bbox, text, score]
             pass

        # Adjust based on observed RapidOCR output structure in __call__
        # read_results from model(img) is list of [bbox, text, score]
        # boxes in response? No, response IS the list.

        # NOTE: rapidocr implementation in ocr_base.py uses response.boxes, response.txts if response is object?
        # But standard rapidocr returns list.
        # I will assume standard list of [box, text, score] here for safety if the other way fails,
        # but try to follow ocr_base.py assuming it might be correct for that specific version.
        # However, checking ocr.py, it does: for read_result in read_results: res += read_result[1]
        # So it is a list of [box, text, score].
        
        if isinstance(response, list):
            for item in response:
                if item is None: continue
                box, text, score = item
                bbox = self._convert_bbox(box, img_width, img_height)
                word = Word(text=text, bounding_box=bbox)
                line = Line(bounding_box=bbox, words=[word], text=text)
                lines.append(line)
        else:
            # Fallback to ocr_base.py object assumption if needed
             for i in range(len(response.boxes)):
                box = response.boxes[i]
                text = response.txts[i]
                bbox = self._convert_bbox(box, img_width, img_height)
                word = Word(text=text, bounding_box=bbox)
                line = Line(bounding_box=bbox, words=[word], text=text)
                lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        read_results, elapsed = self.model(self._preprocess(img))
        ocr_result = self._to_generic_result(read_results, img.width, img.height)
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_numpy_array(img)

class OCRSpace:
    name = 'ocrspace'
    readable_name = 'OCRSpace'
    key = 'o'
    config_entry = 'ocrspace'
    available = False
    local = False
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={}, language='ja'):
        try:
            self.api_key = config['api_key']
            self.max_byte_size = config.get('file_size_limit', 1000000)
            self.engine_version = config.get('engine_version', 2)
            self.language = self.language_to_model_language(language)
            self.available = True
            logger.info('OCRSpace ready')
        except:
            logger.warning('Error reading API key from config, OCRSpace will not work!')
    
    def language_to_model_language(self, language):
        if language == 'ja':
            return 'jpn'
        if language == 'zh':
            return 'chs'
        elif language == 'ko':
            return 'kor'
        elif language == 'ar':
            return 'ara'
        elif language == 'ru':
            return 'rus'
        elif language == 'el':
            return 'gre'
        elif language == 'th':
            return 'tha'
        else:
            return 'auto'

    def _convert_bbox(self, word_data, img_width, img_height):
        left = word_data['Left'] / img_width
        top = word_data['Top'] / img_height
        width = word_data['Width'] / img_width
        height = word_data['Height'] / img_height

        center_x = left + width / 2
        center_y = top + height / 2

        return BoundingBox(
            center_x=center_x,
            center_y=center_y,
            width=width,
            height=height
        )

    def _to_generic_result(self, api_result, img_width, img_height, og_img_width, og_img_height):
        parsed_result = api_result['ParsedResults'][0]
        text_overlay = parsed_result.get('TextOverlay', {})
        lines_data = text_overlay.get('Lines', [])

        lines = []
        for line_data in lines_data:
            words = []
            for word_data in line_data.get('Words', []):
                w_bbox = self._convert_bbox(word_data, img_width, img_height)
                words.append(Word(text=word_data['WordText'], bounding_box=w_bbox))

            l_bbox = merge_bounding_boxes(words)
            lines.append(Line(bounding_box=l_bbox, words=words))

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=og_img_width, height=og_img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')
        
        og_img_width, og_img_height = img.size
        img_bytes, img_extension, img_size = self._preprocess(img)
        if not img_bytes:
            return (False, 'Image is too big!')

        data = {
            'apikey': self.api_key,
            'language': self.language,
            'OCREngine': str(self.engine_version),
            'isOverlayRequired': 'True'
        }
        mp = curl_cffi.CurlMime()
        mp.addpart(name='file', filename=f'image.{img_extension}', content_type=f'image/{img_extension}', data=img_bytes)

        try:
            res = curl_cffi.post('https://api.ocr.space/parse/image', data=data, multipart=mp, timeout=5)
        except curl_cffi.requests.exceptions.Timeout:
            return (False, 'Request timeout!')
        except curl_cffi.requests.exceptions.ConnectionError:
            return (False, 'Connection error!')

        if res.status_code != 200:
            return (False, 'Unknown error!')

        res = res.json()

        if isinstance(res, str):
            return (False, 'Unknown error!')
        if res['IsErroredOnProcessing']:
            return (False, res['ErrorMessage'])

        img_width, img_height = img_size
        ocr_result = self._to_generic_result(res, img_width, img_height, og_img_width, og_img_height)
        x = ocr_result_to_oneocr_tuple((True, ocr_result), furigana_filter_sensitivity)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return limit_image_size(img, self.max_byte_size)


class GeminiOCR:
    name = 'gemini'
    readable_name = 'Gemini'
    key = ';'
    available = False

    def __init__(self, config={'api_key': None}, lang='ja'):
        # if "google-generativeai" not in sys.modules:
        #     logger.warning('google-generativeai not available, GeminiOCR will not work!')
        # else:
        from google import genai
        from google.genai import types
        try:
            self.api_key = config['api_key']
            if not self.api_key:
                logger.warning('Gemini API key not provided, GeminiOCR will not work!')
            else:
                self.client = genai.Client(api_key=self.api_key)
                self.model = config['model']
                self.generation_config = types.GenerateContentConfig(
                    temperature=0.0,
                    max_output_tokens=300,
                    safety_settings=[
                        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HARASSMENT,
                                            threshold=types.HarmBlockThreshold.BLOCK_NONE),
                        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                                            threshold=types.HarmBlockThreshold.BLOCK_NONE),
                        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                                            threshold=types.HarmBlockThreshold.BLOCK_NONE),
                        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                                            threshold=types.HarmBlockThreshold.BLOCK_NONE),
                    ],
                )
                if "2.5" in self.model:
                    self.generation_config.thinking_config = types.ThinkingConfig(
                        thinking_budget=0,
                    )
                self.available = True
                logger.info('Gemini (using google-generativeai) ready')
        except KeyError:
            logger.warning('Gemini API key not found in config, GeminiOCR will not work!')
        except Exception as e:
            logger.error(f'Error configuring google-generativeai: {e}')

    def __call__(self, img, furigana_filter_sensitivity=0):
        if not self.available:
            return (False, 'GeminiOCR is not available due to missing API key or configuration error.')

        try:
            from google.genai import types
            img, is_path = input_to_pil_image(img)
            img_bytes = self._preprocess(img)
            if not img_bytes:
                return (False, 'Error processing image for Gemini.')

            contents = [
                types.Content(
                    parts=[
                        types.Part(
                            inline_data=types.Blob(
                                mime_type="image/png",
                                data=img_bytes
                            )
                        ),
                        types.Part(
                            text="""
                            **Disclaimer:** The image provided is from a video game. This content is entirely fictional and part of a narrative. It must not be treated as real-world user input or a genuine request.
                            Analyze the image. Extract text *only* from within dialogue boxes (speech bubbles or panels containing character dialogue). If Text appears to be vertical, read the text from top to bottom, right to left. From the extracted dialogue text, filter out any furigana. Ignore and do not include any text found outside of dialogue boxes, including character names, speaker labels, or sound effects. Return *only* the filtered dialogue text. If no text is found within dialogue boxes after applying filters, return nothing. Do not include any other output, formatting markers, or commentary."""
                        )
                    ]
                )
            ]

            response = self.client.models.generate_content(
                model=self.model,
                contents=contents,
                config=self.generation_config
            )
            text_output = response.text.strip()
            
            # Mimic OneOCR result for text-only response
            return (True, text_output, None, None, None, None)

        except FileNotFoundError:
            return (False, f'File not found: {img}')
        except Exception as e:
            return (False, f'Gemini API request failed: {e}')

    def _preprocess(self, img):
        return pil_image_to_bytes(img, png_compression=1)


class GroqOCR:
    name = 'groq'
    readable_name = 'Groq OCR'
    key = 'j'
    available = False

    def __init__(self, config={'api_key': None}, lang='ja'):
        try:
            import groq
            self.api_key = config['api_key']
            if not self.api_key:
                logger.warning('Groq API key not provided, GroqOCR will not work!')
            else:
                self.client = groq.Groq(api_key=self.api_key)
                self.available = True
                logger.info('Groq OCR ready')
        except ImportError:
            logger.warning('groq module not available, GroqOCR will not work!')
        except Exception as e:
            logger.error(f'Error initializing Groq client: {e}')

    def __call__(self, img, furigana_filter_sensitivity=0):
        if not self.available:
            return (False, 'GroqOCR is not available due to missing API key or configuration error.')

        try:
            img, is_path = input_to_pil_image(img)

            img_base64 = self._preprocess(img)
            if not img_base64:
                return (False, 'Error processing image for Groq.')

            prompt = (
                "Analyze the image. Extract text *only* from within dialogue boxes (speech bubbles or panels containing character dialogue). If Text appears to be vertical, read the text from top to bottom, right to left. From the extracted dialogue text, filter out any furigana. Ignore and do not include any text found outside of dialogue boxes, including character names, speaker labels, or sound effects. Return *only* the filtered dialogue text. If no text is found within dialogue boxes after applying filters, return nothing. Do not include any other output, formatting markers, or commentary."
                # "Analyze this i#mage and extract text from it"
                # "(speech bubbles or panels containing character dialogue). From the extracted dialogue text, "
                # "filter out any furigana. Ignore and do not include any text found outside of dialogue boxes, "
                # "including character names, speaker labels, or sound effects. Return *only* the filtered dialogue text. "
                # "If no text is found within dialogue boxes after applying filters, return an empty string. "
                # "OR, if there are no text bubbles or dialogue boxes found, return everything."
                # "Do not include any other output, formatting markers, or commentary, only the text from the image."
            )

            response = self.client.chat.completions.create(
                model="meta-llama/llama-4-scout-17b-16e-instruct",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_base64}"}},
                        ],
                    }
                ],
                max_tokens=300,
                temperature=0.0
            )

            if response.choices and response.choices[0].message.content:
                text_output = response.choices[0].message.content.strip()
                return (True, text_output, None, None, None, None)
            else:
                return (True, "", None, None, None, None)

        except FileNotFoundError:
            return (False, f'File not found: {img}')
        except Exception as e:
            return (False, f'Groq API request failed: {e}')

    def _preprocess(self, img):
        return base64.b64encode(pil_image_to_bytes(img, png_compression=1)).decode('utf-8')


# OpenAI-Compatible Endpoint OCR using LM Studio 
class localLLMOCR:
    name= 'local_llm_ocr'
    readable_name = 'Local LLM OCR'
    key = 'a'
    available = False
    last_ocr_time = time.time() - 5

    def __init__(self, config={}, lang='ja'):
        self.keep_llm_hot_thread = None
        # All three config values are required: url, model, api_key
        if not config or not (config.get('url') and config.get('model') and config.get('api_key')):
            logger.warning('Local LLM OCR requires url, model, and api_key in config, Local LLM OCR will not work!')
            return

        try:
            import openai
        except ImportError:
            logger.warning('openai module not available, Local LLM OCR will not work!')
            return
        import openai, threading
        try:
            self.api_url = config.get('url', 'http://localhost:1234/v1/chat/completions')
            self.model = config.get('model', 'qwen2.5-vl-3b-instruct')
            self.api_key = config.get('api_key', 'lm-studio')
            self.keep_warm = config.get('keep_warm', True)
            self.custom_prompt = config.get('prompt', None)
            self.available = True
            if not self.check_url_for_connectivity(self.api_url):
                self.available = False
                logger.warning(f'Local LLM OCR API URL not reachable: {self.api_url}')
                return
            self.client = openai.OpenAI(
                base_url=self.api_url.replace('/v1/chat/completions', '/v1'),
                api_key=self.api_key,
                timeout=1
            )
            if self.client.models.retrieve(self.model):
                self.model = self.model
            logger.info(f'Local LLM OCR (OpenAI-compatible) ready with model {self.model}')
            if self.keep_warm:
                self.keep_llm_hot_thread = threading.Thread(target=self.keep_llm_warm, daemon=True)
                self.keep_llm_hot_thread.start()
        except Exception as e:
            logger.warning(f'Error initializing Local LLM OCR, Local LLM OCR will not work!')
            
    def check_url_for_connectivity(self, url):
        import requests
        try:
            response = requests.get(url, timeout=0.5)
            return response.status_code == 200
        except Exception:
            return False

    def keep_llm_warm(self):
        def ocr_blank_black_image():
            if self.last_ocr_time and (time.time() - self.last_ocr_time) < 5:
                return
            import numpy as np
            from PIL import Image
            # Create a blank black image
            blank_image = Image.fromarray(np.zeros((100, 100, 3), dtype=np.uint8))
            logger.info('Keeping local LLM OCR warm with a blank black image')
            self(blank_image)
        
        while True:
            ocr_blank_black_image()
            time.sleep(5)

    def __call__(self, img, furigana_filter_sensitivity=0):
        import base64
        try:
            img, is_path = input_to_pil_image(img)
            img_bytes = pil_image_to_bytes(img)
            img_base64 = base64.b64encode(img_bytes).decode('utf-8')
            if self.custom_prompt and self.custom_prompt.strip() != "":
                prompt = self.custom_prompt.strip()
            else:
                prompt = f"""
                Extract all {CommonLanguages.from_code(get_ocr_language()).name} Text from Image. Ignore all Furigana. Do not return any commentary, just the text in the image. Do not Translate. If there is no text in the image, return "" (Empty String). 
                """

            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_base64}"}},
                        ],
                    }
                ],
                max_tokens=4096,
                temperature=0.1
            )
            self.last_ocr_time = time.time()
            if response.choices and response.choices[0].message.content:
                text_output = response.choices[0].message.content.strip()
                return (True, text_output, None, None, None, None)
            else:
                return (True, "", None, None, None, None)
        except Exception as e:
            return (False, f'Local LLM OCR request failed: {e}')
        
# import os
# import onnxruntime as ort
# import numpy as np
# import cv2
# from huggingface_hub import hf_hub_download
# from PIL import Image
# import requests
# from io import BytesIO

# --- HELPER FUNCTION FOR VISUALIZATION (Optional but useful) ---
def draw_detections(image: np.ndarray, detections: list, model_name: str) -> np.ndarray:
    """
    Draws bounding boxes from the detection results onto an image.

    Args:
        image (np.ndarray): The original image (in BGR format).
        detections (list): A list of detection dictionaries, e.g., [{"box": [x1, y1, x2, y2], "score": 0.95}, ...].
        model_name (str): The name of the model ('tiny' or 'small') to determine box color.

    Returns:
        np.ndarray: The image with bounding boxes drawn on it.
    """
    output_image = image.copy()
    color = (0, 255, 0) if model_name == "small" else (0, 0, 255) # Green for small, Blue for tiny
    
    for detection in detections:
        box = detection['box']
        score = detection['score']
        
        # Ensure coordinates are integers for drawing
        x_min, y_min, x_max, y_max = map(int, box)
        
        # Draw the rectangle
        cv2.rectangle(output_image, (x_min, y_min), (x_max, y_max), color, 2)
        
        # Optionally, add the score text
        label = f"{score:.2f}"
        cv2.putText(output_image, label, (x_min, y_min - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        
    return output_image


class MeikiTextDetector:
    """
    A class to perform text detection using the meikiocr package. 
    
    This class wraps the MeikiOCR.run_detection method and provides
    the same output format as the previous implementation.
    """
    name = 'meiki_text_detector'
    readable_name = 'Meiki Text Detector'
    available = False
    key = ']'

    def __init__(self, model_name: str = 'small'):
        """
        Initializes the detector using the meikiocr package.

        Args:
            model_name (str): Not used in the new implementation (meikiocr uses its own model).
                              Kept for compatibility.
        """
        self.model = SharedMeikiOCRModel.get_model(force_cpu=get_config().vad.use_cpu_for_inference_v2)
        self.available = self.model is not None
        if self.available:
            logger.info('MeikiTextDetector ready')
        else:
            init_error = SharedMeikiOCRModel.get_init_error()
            if init_error:
                logger.warning(f'Error initializing MeikiTextDetector: {init_error}')
            else:
                logger.warning('meikiocr not available, MeikiTextDetector will not work!')

    def __call__(self, img, confidence_threshold: float = 0.4):
        """
        Performs text detection on an input image.

        Args:
            img: The input image. Can be a PIL Image or a NumPy array (BGR format).
            confidence_threshold (float): The threshold to filter out low-confidence detections.

        Returns:
            A tuple of (True, dict) where dict contains:
                - 'boxes': list of detection dicts with 'box' and 'score'
                - 'provider': 'meiki'
                - 'crop_coords': bounding box around all detections
        """
        if confidence_threshold is None:
            confidence_threshold = 0.4
        if not self.available:
            raise RuntimeError("MeikiTextDetector is not available due to an initialization error.")

        # Convert input to numpy array (BGR format)
        img_pil, is_path = input_to_pil_image(img)
        if not img_pil:
            return False, {'boxes': [], 'provider': 'meiki', 'crop_coords': None}
        
        # Convert PIL to OpenCV BGR format
        input_image = np.array(img_pil.convert('RGB'))
        
        # Run detection using meikiocr
        try:
            text_boxes = self.model.run_detection(input_image, conf_threshold=confidence_threshold)
        except Exception as e:
            logger.error(f'MeikiTextDetector error: {e}')
            return False, {'boxes': [], 'provider': 'meiki', 'crop_coords': None}
        
        # Convert meikiocr format to expected output format
        # meikiocr returns: [{'bbox': [x1, y1, x2, y2]}, ...]
        # we need: [{'box': [x1, y1, x2, y2], 'score': float}, ...]
        detections = []
        for text_box in text_boxes:
            bbox = text_box.get('bbox', [0, 0, 0, 0])
            # meikiocr doesn't return confidence scores from run_detection
            # so we use 1.0 as a placeholder (detection already passed threshold)
            detections.append({
                "box": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                "score": 1.0
            })
        
        # Compute crop_coords as padded min/max of all detected boxes
        if detections:
            x_mins = [b['box'][0] for b in detections]
            y_mins = [b['box'][1] for b in detections]
            x_maxs = [b['box'][2] for b in detections]
            y_maxs = [b['box'][3] for b in detections]

            pad = 5
            crop_xmin = min(x_mins) - pad
            crop_ymin = min(y_mins) - pad
            crop_xmax = max(x_maxs) + pad
            crop_ymax = max(y_maxs) + pad

            # Clamp to image bounds
            h, w = input_image.shape[:2]
            crop_xmin = max(0, int(floor(crop_xmin)))
            crop_ymin = max(0, int(floor(crop_ymin)))
            crop_xmax = min(w, int(floor(crop_xmax)))
            crop_ymax = min(h, int(floor(crop_ymax)))

            crop_coords = [crop_xmin, crop_ymin, crop_xmax, crop_ymax]
        else:
            crop_coords = None

        resp = {
            "boxes": detections,
            "provider": 'meiki',
            "crop_coords": crop_coords
        }
        
        if is_path:
            img_pil.close()

        return True, resp


# --- EXAMPLE USAGE ---
if __name__ == '__main__':
    img = Image.open(r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\owocr\owocr\test_furigana.png")
    # meiki = MeikiOCR()
    meiki = MeikiTextDetector(model_name='small')
    
    times = []
    results = []
    for i in range(500):
        start_t = time.time()
        res = meiki(img)
        end_t = time.time()
        times.append(end_t - start_t)
        results.append(res)
        # time.sleep(0.1)
        
    avg_time = sum(times) / len(times) if times else 0.0
    print(f"Average inference time over 50 runs: {avg_time:.4f} seconds")
    print(results[0])
    
    # bing = Bing()
    
    # re = bing(Image.open(r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\owocr\owocr\test_furigana.png"))
    
    # print(re)
    # import datetime
    # # You can choose 'tiny' or 'small' here
    # meiki = MeikiTextDetector(model_name='small')
    # # Example: run a short warm-up then measure average over N runs
    # image_path = r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\owocr\owocr\lotsofsmalltext.png"
    # video_path = r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\owocr\owocr\tanetsumi_CdACfZkwMY.mp4"
    # # Warm-up run (helps with any one-time setup cost)
    # try:
    #     _ = meiki(image_path, confidence_threshold=0.4)
    # except Exception as e:
    #     print(f"Error running MeikiTextDetector on warm-up: {e}")
    #     raise

    # # runs = 500
    # times = []
    # detections_list = []
    # # for i in range(runs):
    # #     start_time = datetime.datetime.now()
    # #     res, resp_dict = meiki(image_path, confidence_threshold=0.4)
    # #     detections = resp_dict['boxes']
    # #     dections_list.append(detections)
    # #     end_time = datetime.datetime.now()
    # #     times.append((end_time - start_time).total_seconds())
    
    # # Process video frame by frame with cv2 (sample at ~10 FPS)
    # cap = cv2.VideoCapture(video_path)
    # try:
    #     src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    # except Exception:
    #     src_fps = 30.0

    # target_fps = 10
    # sample_interval = max(1, int(round(src_fps / target_fps)))
    # runs = 0
    # last_detections = []
    # pil_img = None

    # while True:
    #     ret, frame = cap.read()
    #     if not ret:
    #         break

    #     # Only process sampled frames
    #     if runs % sample_interval == 0:
    #         # Convert to PIL image
    #         try:
    #             pil_img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    #         except Exception:
    #             runs += 1
    #             continue

    #         # Run Meiki detector on the full frame (or you can crop before passing)
    #         start_t = time.time()
    #         try:
    #             ok, resp = meiki(pil_img, confidence_threshold=0.4)
    #             if ok:
    #                 detections = resp.get('boxes', [])
    #             else:
    #                 detections = []
    #         except Exception as e:
    #             # on error, record empty detections but keep going
    #             detections = []
    #         end_t = time.time()

    #         times.append(end_t - start_t)
    #         detections_list.append(detections)
    #         last_detections = detections

    #     runs += 1

    # cap.release()

    # # Make sure 'detections' variable exists for later visualization
    # detections = last_detections

    # avg_time = sum(times) / len(times) if times else 0.0
    
    # print(f"Average processing/inference time over {runs} runs: {avg_time:.4f} seconds")

    # # --- Stability / similarity analysis across detection runs ---
    # # We consider two boxes the same if their IoU >= iou_threshold.
    # def iou(boxA, boxB):
    #     # boxes are [x_min, y_min, x_max, y_max]
    #     xA = max(boxA[0], boxB[0])
    #     yA = max(boxA[1], boxB[1])
    #     xB = min(boxA[2], boxB[2])
    #     yB = min(boxA[3], boxB[3])

    #     interW = max(0.0, xB - xA)
    #     interH = max(0.0, yB - yA)
    #     interArea = interW * interH

    #     boxAArea = max(0.0, boxA[2] - boxA[0]) * max(0.0, boxA[3] - boxA[1])
    #     boxBArea = max(0.0, boxB[2] - boxB[0]) * max(0.0, boxB[3] - boxB[1])

    #     union = boxAArea + boxBArea - interArea
    #     if union <= 0:
    #         return 0.0
    #     return interArea / union

    # def match_counts(ref_boxes, other_boxes, iou_threshold=0.5):
    #     # Greedy matching by IoU
    #     if not ref_boxes or not other_boxes:
    #         return 0, []
    #     ref_idx = list(range(len(ref_boxes)))
    #     oth_idx = list(range(len(other_boxes)))
    #     matches = []
    #     # compute all IoUs
    #     iou_matrix = []
    #     for i, rb in enumerate(ref_boxes):
    #         row = []
    #         for j, ob in enumerate(other_boxes):
    #             row.append(iou(rb, ob))
    #         iou_matrix.append(row)

    #     iou_matrix = np.array(iou_matrix)
    #     while True:
    #         if iou_matrix.size == 0:
    #             break
    #         # find best remaining pair
    #         idx = np.unravel_index(np.argmax(iou_matrix), iou_matrix.shape)
    #         best_i, best_j = idx[0], idx[1]
    #         best_val = iou_matrix[best_i, best_j]
    #         if best_val < iou_threshold:
    #             break
    #         matches.append((ref_idx[best_i], oth_idx[best_j], float(best_val)))
    #         # remove matched row and column
    #         iou_matrix = np.delete(iou_matrix, best_i, axis=0)
    #         iou_matrix = np.delete(iou_matrix, best_j, axis=1)
    #         del ref_idx[best_i]
    #         del oth_idx[best_j]

    #     return len(matches), matches

    # # canonical reference: first run (if any)
    # stability_scores = []
    # avg_ious = []
    # if len(detections_list) == 0:
    #     stability_avg = 0.0
    # else:
    #     ref = detections_list[0]
    #     # extract boxes list-of-lists
    #     print(ref)
    #     ref_boxes = [d['box'] for d in ref]
    #     for run_idx, run in enumerate(detections_list):
    #         other_boxes = [d['box'] for d in run]
    #         matched_count, matches = match_counts(ref_boxes, other_boxes, iou_threshold=0.5)
    #         denom = max(len(ref_boxes), len(other_boxes), 1)
    #         score = matched_count / denom
    #         stability_scores.append(score)
    #         if matches:
    #             avg_ious.append(sum(m for (_, _, m) in matches) / len(matches))

    #     stability_avg = float(np.mean(stability_scores)) if stability_scores else 0.0
    #     stability_std = float(np.std(stability_scores)) if stability_scores else 0.0
    #     median_stability = float(np.median(stability_scores)) if stability_scores else 0.0
    #     avg_iou_over_matches = float(np.mean(avg_ious)) if avg_ious else 0.0

    # # Heuristic for recommended pixel offset to treat boxes as identical
    # # Use median box dimension across all detections and suggest a small fraction
    # all_widths = []
    # all_heights = []
    # for run in detections_list:
    #     for d in run:
    #         b = d['box']
    #         w = abs(b[2] - b[0])
    #         h = abs(b[3] - b[1])
    #         all_widths.append(w)
    #         all_heights.append(h)

    # if all_widths and all_heights:
    #     med_w = float(np.median(all_widths))
    #     med_h = float(np.median(all_heights))
    #     # suggestion_px: 5px absolute, and also ~5% of median min dimension
    #     suggestion_px = max(5.0, min(med_w, med_h) * 0.05)
    #     suggestion_px_rounded = int(round(suggestion_px))
    # else:
    #     med_w = med_h = 0.0
    #     suggestion_px_rounded = 5

    # # Additional check: if we expand each box by suggestion_px_rounded (on all sides),
    # # would that cause every run to fully match the reference (i.e., every box in
    # # each run matches some reference box and vice-versa using the same IoU threshold)?
    # def expand_box(box, px, img_w=None, img_h=None):
    #     # box: [x_min, y_min, x_max, y_max]
    #     x0, y0, x1, y1 = box
    #     x0 -= px
    #     y0 -= px
    #     x1 += px
    #     y1 += px
    #     if img_w is not None and img_h is not None:
    #         x0 = max(0, x0)
    #         y0 = max(0, y0)
    #         x1 = min(img_w, x1)
    #         y1 = min(img_h, y1)
    #     return [x0, y0, x1, y1]

    # def all_boxes_match_after_expansion(ref_boxes, other_boxes, px_expand, iou_threshold=0.5):
    #     # Expand both sets and perform greedy matching. True if both sets are fully matched.
    #     if not ref_boxes and not other_boxes:
    #         return True
    #     if not ref_boxes or not other_boxes:
    #         return False

    #     # Expand boxes
    #     ref_exp = [expand_box(b, px_expand) for b in ref_boxes]
    #     oth_exp = [expand_box(b, px_expand) for b in other_boxes]

    #     # compute IoU matrix
    #     mat = np.zeros((len(ref_exp), len(oth_exp)), dtype=float)
    #     for i, rb in enumerate(ref_exp):
    #         for j, ob in enumerate(oth_exp):
    #             mat[i, j] = iou(rb, ob)

    #     # greedy match
    #     ref_idx = list(range(len(ref_exp)))
    #     oth_idx = list(range(len(oth_exp)))
    #     matches = 0
    #     m = mat.copy()
    #     while m.size:
    #         idx = np.unravel_index(np.argmax(m), m.shape)
    #         best_i, best_j = idx[0], idx[1]
    #         best_val = m[best_i, best_j]
    #         if best_val < iou_threshold:
    #             break
    #         matches += 1
    #         m = np.delete(m, best_i, axis=0)
    #         m = np.delete(m, best_j, axis=1)
    #         del ref_idx[best_i]
    #         del oth_idx[best_j]

    #     # Fully matched if matches equals both lengths
    #     return (matches == len(ref_exp)) and (matches == len(oth_exp))

    # would_treat_all_same = False
    # per_run_expanded_match = []
    # try:
    #     if len(detections_list) == 0:
    #         would_treat_all_same = False
    #     else:
    #         ref = detections_list[0]
    #         ref_boxes = [d['box'] for d in ref]
    #         for run in detections_list:
    #             other_boxes = [d['box'] for d in run]
    #             matched = all_boxes_match_after_expansion(ref_boxes, other_boxes, suggestion_px_rounded, iou_threshold=0.5)
    #             per_run_expanded_match.append(bool(matched))
    #         would_treat_all_same = all(per_run_expanded_match) if per_run_expanded_match else False
    # except Exception:
    #     would_treat_all_same = False

    # # Print results
    # print(f"Average processing time over {runs} runs: {avg_time:.4f} seconds")
    # print("--- Stability summary (reference = first run) ---")
    # if len(detections_list) == 0:
    #     print("No detections recorded.")
    # else:
    #     print(f"Per-run similarity ratios vs first run: {[round(s,3) for s in stability_scores]}")
    #     print(f"Stability average: {stability_avg:.4f}, std: {stability_std:.4f}, median: {median_stability:.4f}")
    #     print(f"Average IoU (matched boxes): {avg_iou_over_matches:.4f}")
    #     print(f"Median box size (w x h): {med_w:.1f} x {med_h:.1f} px")
    #     print(f"Recommended pixel-offset heuristic to treat boxes as identical: {suggestion_px_rounded} px (~5% of median box min-dim).")
    #     print(f"Per-run fully-matched after expanding by {suggestion_px_rounded}px: {per_run_expanded_match}")
    #     print(f"Would the recommendation treat all runs as identical? {would_treat_all_same}")
    #     print("Also consider fixed offsets like 5px or 10px depending on image DPI and scaling.")


    # # Draw and save the last-run detections for inspection
    # if pil_img:
    #     image_path = os.path.join(os.getcwd(), "last_frame_for_detections.png")
    #     pil_img.save(image_path)
    # try:
    #     src_img = cv2.imread(image_path)
    #     if src_img is not None:
    #         res_img = draw_detections(image=src_img, detections=detections, model_name=meiki.model_name)
    #         out_path = Path(image_path).with_name(f"detection_result_{meiki.model_name}.png")
    #         cv2.imwrite(str(out_path), res_img)
    #         print(f"Saved detection visualization to: {out_path}")
    #     else:
    #         print(f"Could not read image for visualization: {image_path}")
    # except Exception as e:
    #     print(f"Error drawing/saving detections: {e}")

    # print(f"Average processing time over {runs} runs: {avg_time:.4f} seconds")

    # if detector.available:
    #     # Example image URL
    #     # image_url = "https://huggingface.co/rtr46/meiki.text.detect.v0/resolve/main/test_images/manga.jpg"
    #     # image_url = "https://huggingface.co/rtr46/meiki.text.detect.v0/resolve/main/test_images/sign.jpg"
        
    #     print(f"\nProcessing image from URL: {image_url}")
        
    #     # The __call__ method handles the URL directly
    #     detections = detector(image_url, confidence_threshold=0.4)

    #     # Print the results
    #     print("\nDetections:")
    #     for det in detections:
    #         # Formatting the box coordinates to 2 decimal places for cleaner printing
    #         formatted_box = [f"{coord:.2f}" for coord in det['box']]
    #         print(f"  - Box: {formatted_box}, Score: {det['score']:.4f}")

    #     # --- Visualization ---
    #     print("\nVisualizing results... Check for a window named 'Detection Result'.")
    #     # Load image again for drawing
    #     response = requests.get(image_url)
    #     pil_img = Image.open(BytesIO(response.content)).convert("RGB")
    #     original_image_np = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

    #     # Use the helper function to draw the detections
    #     result_image = draw_detections(original_image_np, detections, detector.model_name)

    #     # Save or display the image
    #     output_path = "detection_result.jpg"
    #     cv2.imwrite(output_path, result_image)
    #     print(f"Result saved to {output_path}")

    #     # To display in a window (press any key to close)
    #     # cv2.imshow("Detection Result", result_image)
    #     # cv2.waitKey(0)
    #     # cv2.destroyAllWindows()
    # else:
    #     print("\nDetector could not be initialized. Please check the error messages above.")


# class QWENOCR:
#     name = 'qwenv2'
#     readable_name = 'Qwen2-VL'
#     key = 'q'
    
#     # Class-level attributes for model and processor to ensure they are loaded only once
#     model = None
#     processor = None
#     device = None
#     available = False

#     @classmethod
#     def initialize(cls):
#         import torch
#         from transformers import AutoModelForImageTextToText, AutoProcessor
#         """
#         Class method to initialize the model. Call this once at the start of your application.
#         This prevents reloading the model on every instantiation.
#         """
#         if cls.model is not None:
#             logger.info('Qwen2-VL is already initialized.')
#             return

#         try:
#             if not torch.cuda.is_available():
#                 logger.warning("CUDA not available, Qwen2-VL will run on CPU, which will be very slow.")
#                 # You might want to prevent initialization on CPU entirely
#                 # raise RuntimeError("CUDA is required for efficient Qwen2-VL operation.")
            
#             cls.device = "cuda" if torch.cuda.is_available() else "cpu"
            
#             cls.model = AutoModelForImageTextToText.from_pretrained(
#                 "Qwen/Qwen2-VL-2B-Instruct", 
#                 torch_dtype="auto", # Uses bfloat16/float16 if available, which is faster
#                 device_map=cls.device
#             )
#             # For PyTorch 2.0+, torch.compile can significantly speed up inference after a warm-up call
#             # cls.model = torch.compile(cls.model) 
            
#             cls.processor = AutoProcessor.from_pretrained(
#                 "Qwen/Qwen2-VL-2B-Instruct", 
#                 use_fast=True
#             )
            
#             cls.available = True
            
#             conversation = [
#                 {
#                     "role": "user",
#                     "content": [
#                         {"type": "image"},
#                         {"type": "text", "text": "Extract all the text from this image, ignore all furigana."},
#                     ],
#                 }
#             ]
            
#             # The same prompt is applied to all images in the batch
#             cls.text_prompt = cls.processor.apply_chat_template(conversation, add_generation_prompt=True, tokenize=False)
#             logger.info(f'Qwen2.5-VL ready on device: {cls.device}')
#         except Exception as e:
#             logger.warning(f'Qwen2-VL not available: {e}')
#             cls.available = False

#     def __init__(self, config={}, lang='ja'):
#         # The __init__ is now very lightweight. It just checks if initialization has happened.
#         if not self.available:
#             raise RuntimeError("QWENOCR has not been initialized. Call QWENOCR.initialize() first.")

#     def __call__(self, images):
#         """
#         Processes a single image or a list of images.
#         :param images: A single image (path or PIL.Image) or a list of images.
#         :return: A tuple (success, list_of_results)
#         """
#         if not self.available:
#             return (False, ['Qwen2-VL is not available.'])
            
#         try:
#             # Standardize input to be a list
#             if not isinstance(images, list):
#                 images = [images]

#             pil_images = [input_to_pil_image(img)[0] for img in images]
            
#             # The processor handles batching of images and text prompts
#             inputs = self.processor(
#                 text=[self.text_prompt] * len(pil_images), 
#                 images=pil_images, 
#                 padding=True, 
#                 return_tensors="pt"
#             ).to(self.device)

#             output_ids = self.model.generate(**inputs, max_new_tokens=32)

#             # The decoding logic needs to be slightly adjusted for batching
#             input_ids_len = [len(x) for x in inputs.input_ids]
#             generated_ids = [
#                 output_ids[i][input_ids_len[i]:] for i in range(len(input_ids_len))
#             ]

#             output_text = self.processor.batch_decode(
#                 generated_ids, skip_special_tokens=True, clean_up_tokenization_spaces=True
#             )
            
#             return (True, output_text)
#         except Exception as e:
#             return (False, [f'Qwen2-VL inference failed: {e}'])


# QWENOCR.initialize()
# qwenocr = QWENOCR()

# localOCR = localLLMOCR(config={'api_url': 'http://localhost:1234/v1/chat/completions', 'model': 'qwen2.5-vl-3b-instruct'})

# for i in range(10):
#     start_time = time.time()
#     res, text = localOCR(Image.open('test_furigana.png'))  # Example usage
#     end_time = time.time()

#     print(f"Time taken: {end_time - start_time:.2f} seconds")
#     print(text)
