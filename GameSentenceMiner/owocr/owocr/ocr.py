import re
import os
import io
import time
from pathlib import Path
import sys
import platform
import logging
from math import sqrt, floor
import json
import base64
from urllib.parse import urlparse, parse_qs
import warnings

import numpy as np
import rapidfuzz.fuzz
from PIL import Image
from loguru import logger
import regex
import curl_cffi


try:
    from GameSentenceMiner.util.electron_config import get_ocr_language, get_furigana_filter_sensitivity
    from GameSentenceMiner.util.configuration import CommonLanguages
except ImportError:
    pass

# from GameSentenceMiner.util.configuration import get_temporary_directory

try:
    from manga_ocr import MangaOcr as MOCR
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
    import urllib.request
except ImportError:
    pass

try:
    import winocr
except ImportError:
    pass

try:
    try:
        if os.path.exists(os.path.expanduser('~/.config/oneocr/oneocr.dll')):
            import oneocr
    except Exception as e:
        oneocr = None
        logger.warning(f'Failed to import OneOCR: {e}', exc_info=True)
except ImportError:
    pass

try:
    import pyjson5
except ImportError:
    pass

try:
    import betterproto
    from GameSentenceMiner.owocr.owocr.lens_betterproto import *
    import random
except ImportError:
    pass

try:
    import fpng_py
    optimized_png_encode = True
except:
    optimized_png_encode = False

try:
    from meikiocr import MeikiOCR as MKOCR
except ImportError:
    pass

meiki_model = None


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
        pil_image = Image.open(io.BytesIO(img))
    elif isinstance(img, Path):
        is_path = True
        try:
            pil_image = Image.open(img)
            pil_image.load()
        except (UnidentifiedImageError, OSError) as e:
            return None
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
        return img_bytes, 'png'

    scaling_factor = 0.60 if any(x > 2000 for x in img.size) else 0.75
    new_w = int(img.width * scaling_factor)
    new_h = int(img.height * scaling_factor)
    resized_img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    resized_img_bytes = pil_image_to_bytes(resized_img)
    if len(resized_img_bytes) <= max_size:
        return resized_img_bytes, 'png'

    for _ in range(2):
        jpeg_quality = 80
        while jpeg_quality >= 60:
            img_bytes = pil_image_to_bytes(img, 'jpeg', jpeg_quality=jpeg_quality, optimize=True)
            if len(img_bytes) <= max_size:
                return img_bytes, 'jpeg'
            jpeg_quality -= 5
        img = resized_img

    return False, ''


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


class MangaOcr:
    name = 'mangaocr'
    readable_name = 'Manga OCR'
    key = 'm'
    available = False

    def __init__(self, config={'pretrained_model_name_or_path':'kha-white/manga-ocr-base','force_cpu': False}, lang='ja'):
        if 'manga_ocr' not in sys.modules:
            logger.warning('manga-ocr not available, Manga OCR will not work!')
        else:
            logger.disable('manga_ocr')
            logging.getLogger('transformers').setLevel(logging.ERROR) # silence transformers >=4.46 warnings
            from manga_ocr import ocr
            ocr.post_process = empty_post_process
            logger.info(f'Loading Manga OCR model')
            self.model = MOCR(config['pretrained_model_name_or_path'], config['force_cpu'])
            self.available = True
            logger.info('Manga OCR ready')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        x = (True, self.model(img))

        # img.close()
        return x

class GoogleVision:
    name = 'gvision'
    readable_name = 'Google Vision'
    key = 'g'
    available = False

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

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        image_bytes = self._preprocess(img)
        image = vision.Image(content=image_bytes)
        try:
            response = self.client.text_detection(image=image)
        except ServiceUnavailable:
            return (False, 'Connection error!')
        except:
            return (False, 'Unknown error!')
        texts = response.text_annotations
        res = texts[0].description if len(texts) > 0 else ''
        x = (True, res)

        # img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img)

class GoogleLens:
    name = 'glens'
    readable_name = 'Google Lens'
    key = 'l'
    available = False

    def __init__(self, lang='ja', get_furigana_sens_from_file=True):
        import regex
        self.regex = get_regex(lang)
        self.initial_lang = lang
        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}]')
        self.get_furigana_sens_from_file = get_furigana_sens_from_file
        if 'betterproto' not in sys.modules:
            logger.warning('betterproto not available, Google Lens will not work!')
        else:
            self.available = True
            logger.info('Google Lens ready')

    def __call__(self, img, furigana_filter_sensitivity=0, return_coords=False):
        if self.get_furigana_sens_from_file:
            furigana_filter_sensitivity = get_furigana_filter_sensitivity()
        else:
            furigana_filter_sensitivity = furigana_filter_sensitivity
        lang = get_ocr_language()
        img, is_path = input_to_pil_image(img)
        if lang != self.initial_lang:
            self.initial_lang = lang
            self.regex = get_regex(lang)
        if not img:
            return (False, 'Invalid image provided')

        request = LensOverlayServerRequest()

        request.objects_request.request_context.request_id.uuid = random.randint(0, 2**64 - 1)
        request.objects_request.request_context.request_id.sequence_id = 0
        request.objects_request.request_context.request_id.image_sequence_id = 0
        request.objects_request.request_context.request_id.analytics_id = random.randbytes(16)
        request.objects_request.request_context.request_id.routing_info = LensOverlayRoutingInfo()

        request.objects_request.request_context.client_context.platform = Platform.WEB
        request.objects_request.request_context.client_context.surface = Surface.CHROMIUM

        request.objects_request.request_context.client_context.locale_context.language = 'ja'
        request.objects_request.request_context.client_context.locale_context.region = 'Asia/Tokyo'
        request.objects_request.request_context.client_context.locale_context.time_zone = '' # not set by chromium

        request.objects_request.request_context.client_context.app_id = '' # not set by chromium

        filter = AppliedFilter()
        filter.filter_type = LensOverlayFilterType.AUTO_FILTER
        request.objects_request.request_context.client_context.client_filters.filter.append(filter)

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
        except curl_cffi.exceptions.Timeout:
            return (False, 'Request timeout!')
        except curl_cffi.exceptions.ConnectionError:
            return (False, 'Connection error!')

        if res.status_code != 200:
            return (False, 'Unknown error!')

        response_proto = LensOverlayServerResponse().FromString(res.content)
        response_dict = response_proto.to_dict(betterproto.Casing.SNAKE)

        if os.path.exists(r"C:\Users\Beangate\GSM\test"):
            with open(os.path.join(r"C:\Users\Beangate\GSM\test", 'glens_response.json'), 'w', encoding='utf-8') as f:
                json.dump(response_dict, f, indent=4, ensure_ascii=False)
        res = ''
        text = response_dict['objects_response']['text']
        skipped = []
        previous_line = None
        filtered_response_dict = response_dict
        if furigana_filter_sensitivity:
            import copy
            filtered_response_dict = copy.deepcopy(response_dict)
            filtered_paragraphs = []
        
        if 'text_layout' in text:
            for paragraph in text['text_layout']['paragraphs']:
                if previous_line:
                    prev_bbox = previous_line['geometry']['bounding_box']
                    curr_bbox = paragraph['geometry']['bounding_box']
                    vertical_space = abs(curr_bbox['center_y'] - prev_bbox['center_y']) * img.height
                    prev_height = prev_bbox['height'] * img.height
                    current_height = curr_bbox['height'] * img.height
                    avg_height = (prev_height + current_height) / 2
                    # If vertical space is close to previous line's height, add a blank line
                    # logger.info(f"Vertical space: {vertical_space}, Average height: {avg_height}")
                    # logger.info(avg_height * 2)
                    if vertical_space > avg_height * 2:
                        res += 'BLANK_LINE\n'
                passed_furigana_filter_lines = []
                for line in paragraph['lines']:
                    if furigana_filter_sensitivity:
                        line_width = line['geometry']['bounding_box']['width'] * img.width
                        line_height = line['geometry']['bounding_box']['height'] * img.height
                        passes = False
                        for word in line['words']:
                            if self.punctuation_regex.findall(word['plain_text']):
                                res += word['plain_text'] + word['text_separator']
                                continue
                            if line_width > furigana_filter_sensitivity and line_height > furigana_filter_sensitivity:
                                res += word['plain_text'] + word['text_separator']
                                passes = True
                            else:
                                skipped.extend(word['plain_text'])
                                continue
                        if passes:
                            passed_furigana_filter_lines.append(line)
                    else:
                        for word in line['words']:
                            res += word['plain_text'] + word['text_separator']
                    res += '\n'

                if furigana_filter_sensitivity and passed_furigana_filter_lines:
                    # Create a filtered paragraph with only the passing lines
                    filtered_paragraph = paragraph.copy()
                    filtered_paragraph['lines'] = passed_furigana_filter_lines
                    filtered_paragraphs.append(filtered_paragraph)
                
                previous_line = paragraph
            
            if furigana_filter_sensitivity:
                filtered_response_dict['objects_response']['text']['text_layout']['paragraphs'] = filtered_paragraphs
            
            res += '\n'
            # logger.info(
            #     f"Skipped {len(skipped)} chars due to furigana filter sensitivity: {furigana_filter_sensitivity}")
            # widths = []
            # heights = []
            # if 'text_layout' in text:
            #     paragraphs = text['text_layout']['paragraphs']
            #     for paragraph in paragraphs:
            #         for line in paragraph['lines']:
            #             for word in line['words']:
            #                 if self.kana_kanji_regex.search(word['plain_text']) is None:
            #                     continue
            #                 widths.append(word['geometry']['bounding_box']['width'])
            #                 heights.append(word['geometry']['bounding_box']['height'])
            #
            # max_width = max(sorted(widths)[:-max(1, len(widths) // 10)]) if len(widths) > 1 else 0
            # max_height = max(sorted(heights)[:-max(1, len(heights) // 10)]) if len(heights) > 1 else 0
            #
            # required_width = max_width * furigana_filter_sensitivity
            # required_height = max_height * furigana_filter_sensitivity
            #
            # if 'text_layout' in text:
            #     paragraphs = text['text_layout']['paragraphs']
            #     for paragraph in paragraphs:
            #         for line in paragraph['lines']:
            #             if furigana_filter_sensitivity == 0 or line['geometry']['bounding_box']['width'] > required_width or line['geometry']['bounding_box']['height'] > required_height:
            #                 for word in line['words']:
            #                         res += word['plain_text'] + word['text_separator']
            #             else:
            #                 continue
            #         res += '\n'
        # else:
        #     if 'text_layout' in text:
        #         paragraphs = text['text_layout']['paragraphs']
        #         for paragraph in paragraphs:
        #             for line in paragraph['lines']:
        #                 for word in line['words']:
        #                         res += word['plain_text'] + word['text_separator']
        #                 else:
        #                     continue
        #             res += '\n'
        
        if return_coords:
            x = (True, res, filtered_response_dict)
        else:
            x = (True, res)

        if skipped:
            logger.info(f"Skipped {len(skipped)} chars due to furigana filter sensitivity: {furigana_filter_sensitivity}")
            logger.debug(f"Skipped chars: {''.join(skipped)}")

        # img.close()
        return x

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
    available = False

    def __init__(self, lang='ja'):
        self.requests_session = curl_cffi.Session()
        self.available = True
        logger.info('Bing ready')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        img_bytes = self._preprocess(img)
        if not img_bytes:
            return (False, 'Image is too big!')

        upload_url = 'https://www.bing.com/images/search?view=detailv2&iss=sbiupload'
        upload_headers = {
            'origin': 'https://www.bing.com',
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
            'referer': f'https://www.bing.com/images/search?view=detailV2&insightstoken={image_insights_token}',
        }
        api_data_json = {
            'imageInfo': {'imageInsightsToken': image_insights_token, 'source': 'Url'},
            'knowledgeRequest': {'invokedSkills': ['OCR'], 'index': 1}
        }
        mp2 = curl_cffi.CurlMime()
        mp2.addpart(name='knowledgeRequest', content_type='application/json', data=json.dumps(api_data_json))

        try:
            res = self.requests_session.post(api_url, headers=api_headers, multipart=mp2, impersonate='chrome', timeout=5)
        except curl_cffi.requests.exceptions.Timeout:
            return (False, 'Request timeout!')
        except curl_cffi.requests.exceptions.ConnectionError:
            return (False, 'Connection error!')

        if res.status_code != 200:
            return (False, 'Unknown error!')

        data = res.json()

        res = ''
        text_tag = None
        for tag in data['tags']:
            if tag.get('displayName') == '##TextRecognition':
                text_tag = tag
                break
        if text_tag:
            text_action = None
            for action in text_tag['actions']:
                if action.get('_type') == 'ImageKnowledge/TextRecognitionAction':
                    text_action = action
                    break
            if text_action:
                regions = text_action['data'].get('regions', [])
                for region in regions:
                    for line in region.get('lines', []):
                        res += line['text'] + '\n'

        x = (True, res)

        # img.close()
        return x

    def _preprocess(self, img):
        max_pixel_size = 4000
        max_byte_size = 767772
        res = None

        if any(x > max_pixel_size for x in img.size):
            resize_factor = max(max_pixel_size / img.width, max_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        img_bytes, _ = limit_image_size(img, max_byte_size)

        if img_bytes:
            res = base64.b64encode(img_bytes).decode('utf-8')

        return res

class AppleVision:
    name = 'avision'
    readable_name = 'Apple Vision'
    key = 'a'
    available = False

    def __init__(self, lang='ja'):
        if sys.platform != 'darwin':
            logger.warning('Apple Vision is not supported on non-macOS platforms!')
        elif int(platform.mac_ver()[0].split('.')[0]) < 13:
            logger.warning('Apple Vision is not supported on macOS older than Ventura/13.0!')
        else:
            self.available = True
            logger.info('Apple Vision ready')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        with objc.autorelease_pool():
            req = Vision.VNRecognizeTextRequest.alloc().init()

            req.setRevision_(Vision.VNRecognizeTextRequestRevision3)
            req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
            req.setUsesLanguageCorrection_(True)
            req.setRecognitionLanguages_(['ja','en'])

            handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(
                self._preprocess(img), None
            )

            success = handler.performRequests_error_([req], None)
            res = ''
            if success[0]:
                for result in req.results():
                    res += result.text() + '\n'
                x = (True, res)
            else:
                x = (False, 'Unknown error!')

            # img.close()
            return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img, 'tiff')


class AppleLiveText:
    name = 'alivetext'
    readable_name = 'Apple Live Text'
    key = 'd'
    available = False

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
            self.available = True
            logger.info('Apple Live Text ready')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        with objc.autorelease_pool():
            analyzer = self.VKCImageAnalyzer.alloc().init()
            req = self.VKCImageAnalyzerRequest.alloc().initWithImage_requestType_(self._preprocess(img), 1) #VKAnalysisTypeText
            req.setLocales_(['ja','en'])
            self.result = None
            analyzer.processRequest_progressHandler_completionHandler_(req, lambda progress: None, self._process)

            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 10.0, False)

            if self.result == None:
                return (False, 'Unknown error!')
            return (True, self.result)

    def _process(self, analysis, error):
        res = ''
        lines = analysis.allLines()
        if lines:
            for line in lines:
                res += line.string() + '\n'
        self.result = res
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
    available = False

    def __init__(self, config={}, lang='ja'):
        if sys.platform == 'win32':
            if int(platform.release()) < 10:
                logger.warning('WinRT OCR is not supported on Windows older than 10!')
            elif 'winocr' not in sys.modules:
                logger.warning('winocr not available, WinRT OCR will not work!')
            else:
                self.available = True
                logger.info('WinRT OCR ready')
        else:
            try:
                self.url = config['url']
                self.available = True
                logger.info('WinRT OCR ready')
            except:
                logger.warning('Error reading URL from config, WinRT OCR will not work!')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        if sys.platform == 'win32':
            res = winocr.recognize_pil_sync(img, lang='ja')['text']
        else:
            params = {'lang': 'ja'}
            try:
                res = curl_cffi.post(self.url, params=params, data=self._preprocess(img), timeout=3)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')

            if res.status_code != 200:
                return (False, 'Unknown error!')

            res = res.json()['text']

        x = (True, res)


        # img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img, png_compression=1)

class OneOCR:
    name = 'oneocr'
    readable_name = 'OneOCR'
    key = 'z'
    available = False

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
            elif not os.path.exists(os.path.expanduser('~/.config/oneocr/oneocr.dll')):
                logger.warning('OneOCR DLLs not found, please install OwOCR Dependencies via OCR Tab in GSM.')
            else:
                try:
                    logger.info(f'Loading OneOCR model')
                    self.model = oneocr.OcrEngine()
                except RuntimeError as e:
                    logger.warning(e + ', OneOCR will not work!')
                else:
                    self.available = True
                    logger.info('OneOCR ready')
        else:
            try:
                self.url = config['url']
                self.available = True
                logger.info('OneOCR ready')
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
        if img.width < 51 or img.height < 51:
            new_width = max(img.width, 51)
            new_height = max(img.height, 51)
            new_img = Image.new("RGBA", (new_width, new_height), (0, 0, 0, 0))
            new_img.paste(img, ((new_width - img.width) // 2, (new_height - img.height) // 2))
            img = new_img
        if not img:
            return (False, 'Invalid image provided')
        crop_coords = None
        crop_coords_list = []
        ocr_resp = ''
        if sys.platform == 'win32':
            try:
                ocr_resp = self.model.recognize_pil(img)
                if os.path.exists(os.path.expanduser("~/GSM/temp")):
                    with open(os.path.join(os.path.expanduser("~/GSM/temp"), 'oneocr_response.json'), 'w',
                                encoding='utf-8') as f:
                        json.dump(ocr_resp, f, indent=4, ensure_ascii=False)
                # print(json.dumps(ocr_resp))
                filtered_lines = [line for line in ocr_resp['lines'] if self.regex.search(line['text'])]
                x_coords = [line['bounding_rect'][f'x{i}'] for line in filtered_lines for i in range(1, 5)]
                y_coords = [line['bounding_rect'][f'y{i}'] for line in filtered_lines for i in range(1, 5)]
                if x_coords and y_coords:
                    crop_coords = (min(x_coords) - 5, min(y_coords) - 5, max(x_coords) + 5, max(y_coords) + 5)
                # logger.info(filtered_lines)
                res = ''
                skipped = []
                boxes = []
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
                            # Line passes - include all its text and add to passing_lines
                            for char in line['words']:
                                res += char['text']
                            passing_lines.append(line)
                        else:
                            # Line fails - only include punctuation, skip the rest
                            for char in line['words']:
                                skipped.extend(char for char in line['text'])
                        res += '\n'
                    filtered_lines = passing_lines
                    return_resp = {'text': res, 'text_angle': ocr_resp['text_angle'], 'lines': passing_lines}
                    # logger.info(
                    #     f"Skipped {len(skipped)} chars due to furigana filter sensitivity: {furigana_filter_sensitivity}")
                    # widths, heights = [], []
                    # for line in ocr_resp['lines']:
                    #     for word in line['words']:
                    #         if self.kana_kanji_regex.search(word['text']) is None:
                    #             continue
                    #         # x1, x2, x3, x4 = line['bounding_rect']['x1'], line['bounding_rect']['x2'], line['bounding_rect']['x3'], line['bounding_rect']['x4']
                    #         # y1, y2, y3, y4 = line['bounding_rect']['y1'], line['bounding_rect']['y2'], line['bounding_rect']['y3'], line['bounding_rect']['y4']
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
                    res = ocr_resp['text']
                    return_resp = ocr_resp
                    
                for line in filtered_lines:
                    crop_coords_list.append(
                        (line['bounding_rect']['x1'] - 5, line['bounding_rect']['y1'] - 5,
                            line['bounding_rect']['x3'] + 5, line['bounding_rect']['y3'] + 5, line['text']))

            except RuntimeError as e:
                return (False, e)
        else:
            try:
                res = curl_cffi.post(self.url, data=self._preprocess(img), timeout=3)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')

            if res.status_code != 200:
                return (False, 'Unknown error!')

            res = res.json()['text']

        x = [True, res]
        if return_coords:
            x.append(filtered_lines)
        x.append(crop_coords_list)
        if return_one_box:
            x.append(crop_coords)
        if return_dict:
            x.append(return_resp)
        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img, png_compression=1)
    

class MeikiOCR:
    name = 'meikiocr'
    readable_name = 'MeikiOCR'
    key = 'k'
    available = False

    def __init__(self, config={}, lang='ja', get_furigana_sens_from_file=True):
        global meiki_model
        import regex
        self.initial_lang = lang
        self.regex = get_regex(lang)
        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}]')
        self.get_furigana_sens_from_file = get_furigana_sens_from_file
        if 'meikiocr' not in sys.modules:
            logger.warning('meikiocr not available, MeikiOCR will not work!')
        elif meiki_model:
            self.model = meiki_model
            self.available = True
            logger.info('MeikiOCR ready')
        else:
            try:
                logger.info('Loading MeikiOCR model')
                meiki_model = MKOCR()
                self.model = meiki_model
                self.available = True
                logger.info('MeikiOCR ready')
            except RuntimeError as e:
                logger.warning(str(e) + ', MeikiOCR will not work!')
            except Exception as e:
                logger.warning(f'Error loading MeikiOCR: {e}, MeikiOCR will not work!')

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
            
            new_img = Image.fromarray(image_np)
            if os.path.exists(os.path.expanduser("~/GSM/temp")):
                new_img.save(os.path.join(os.path.expanduser("~/GSM/temp"), 'meikiocr_input.png'))
            
            # Run meikiocr
            read_results = self.model.run_ocr(image_np, punct_conf_factor=0.2)
            
            # Convert meikiocr response to OneOCR format
            ocr_resp = self._convert_meikiocr_to_oneocr_format(read_results, img.width, img.height)
            
            if os.path.exists(os.path.expanduser("~/GSM/temp")):
                with open(os.path.join(os.path.expanduser("~/GSM/temp"), 'meikiocr_response.json'), 'w',
                            encoding='utf-8') as f:
                    json.dump(ocr_resp, f, indent=4, ensure_ascii=False)
            
            filtered_lines = [line for line in ocr_resp['lines'] if self.regex.search(line['text'])]
            x_coords = [line['bounding_rect'][f'x{i}'] for line in filtered_lines for i in range(1, 5)]
            y_coords = [line['bounding_rect'][f'y{i}'] for line in filtered_lines for i in range(1, 5)]
            if x_coords and y_coords:
                crop_coords = (min(x_coords) - 5, min(y_coords) - 5, max(x_coords) + 5, max(y_coords) + 5)
            
            res = ''
            skipped = []
            boxes = []
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
                        # Line passes - include all its text and add to passing_lines
                        for char in line['words']:
                            res += char['text']
                        passing_lines.append(line)
                    else:
                        # Line fails - only include punctuation, skip the rest
                        for char in line['words']:
                            skipped.extend(char for char in line['text'])
                    res += '\n'
                filtered_lines = passing_lines
                return_resp = {'text': res, 'text_angle': ocr_resp['text_angle'], 'lines': passing_lines}
            else:
                res = ocr_resp['text']
                return_resp = ocr_resp
                
            for line in filtered_lines:
                crop_coords_list.append(
                    (line['bounding_rect']['x1'] - 5, line['bounding_rect']['y1'] - 5,
                        line['bounding_rect']['x3'] + 5, line['bounding_rect']['y3'] + 5))

        except RuntimeError as e:
            return (False, str(e))
        except Exception as e:
            return (False, f'MeikiOCR error: {str(e)}')

        x = [True, res]
        if return_coords:
            x.append(filtered_lines)
        x.append(crop_coords_list)
        if return_one_box:
            x.append(crop_coords)
        if return_dict:
            x.append(return_resp)
        if is_path:
            img.close()
        return x

    def _convert_meikiocr_to_oneocr_format(self, meikiocr_results, img_width, img_height):
        """
        Convert meikiocr output format to match OneOCR format.
        
        meikiocr returns: [{"text": "line text", "chars": [{"char": "字", "bbox": [x1, y1, x2, y2], "conf": 0.9}, ...]}, ...]
        
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
        full_text = ''
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
            
            full_text += line_text + '\n'
        
        return {
            'text': full_text.rstrip('\n'),
            'text_angle': 0,
            'lines': lines
        }

    def _preprocess(self, img):
        return pil_image_to_bytes(img, png_compression=1)


class AzureImageAnalysis:
    name = 'azure'
    readable_name = 'Azure Image Analysis'
    key = 'v'
    available = False

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

        res = ''
        if read_result.read:
            for block in read_result.read.blocks:
                for line in block.lines:
                    res += line.text + '\n'
        else:
            return (False, 'Unknown error!')

        x = (True, res)

        # img.close()
        return x

    def _preprocess(self, img):
        if any(x < 50 for x in img.size):
            resize_factor = max(50 / img.width, 50 / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        return pil_image_to_bytes(img)

class EasyOCR:
    name = 'easyocr'
    readable_name = 'EasyOCR'
    key = 'e'
    available = False

    def __init__(self, config={'gpu': True}, lang='ja'):
        if 'easyocr' not in sys.modules:
            logger.warning('easyocr not available, EasyOCR will not work!')
        else:
            logger.info('Loading EasyOCR model')
            logging.getLogger('easyocr.easyocr').setLevel(logging.ERROR)
            self.model = easyocr.Reader(['ja','en'], gpu=config['gpu'])
            self.available = True
            logger.info('EasyOCR ready')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        res = ''
        read_result = self.model.readtext(self._preprocess(img), detail=0)
        for text in read_result:
            res += text + '\n'

        x = (True, res)

        # img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_numpy_array(img)

class RapidOCR:
    name = 'rapidocr'
    readable_name = 'RapidOCR'
    key = 'r'
    available = False

    def __init__(self, lang='ja'):
        if 'rapidocr_onnxruntime' not in sys.modules:
            logger.warning('rapidocr_onnxruntime not available, RapidOCR will not work!')
        else:
            rapidocr_model_file = os.path.join(os.path.expanduser('~'),'.cache','rapidocr_japan_PP-OCRv4_rec_infer.onnx')
            if not os.path.isfile(rapidocr_model_file):
                logger.info('Downloading RapidOCR model ' + rapidocr_model_file)
                try:
                    cache_folder = os.path.join(os.path.expanduser('~'),'.cache')
                    if not os.path.isdir(cache_folder):
                        os.makedirs(cache_folder)
                    urllib.request.urlretrieve('https://github.com/AuroraWright/owocr/raw/master/rapidocr_japan_PP-OCRv4_rec_infer.onnx', rapidocr_model_file)
                except:
                    logger.warning('Download failed. RapidOCR will not work!')
                    return

            logger.info('Loading RapidOCR model')
            self.model = ROCR(rec_model_path=rapidocr_model_file)
            logging.getLogger().setLevel(logging.ERROR)
            self.available = True
            logger.info('RapidOCR ready')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        res = ''
        read_results, elapsed = self.model(self._preprocess(img))
        if read_results:
            for read_result in read_results:
                res += read_result[1] + '\n'

        x = (True, res)

        # img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_numpy_array(img)

class OCRSpace:
    name = 'ocrspace'
    readable_name = 'OCRSpace'
    key = 'o'
    available = False

    def __init__(self, config={}, lang='ja'):
        try:
            self.api_key = config['api_key']
            self.max_byte_size = config.get('file_size_limit', 1000000)
            self.available = True
            logger.info('OCRSpace ready')
        except:
            logger.warning('Error reading API key from config, OCRSpace will not work!')

    def __call__(self, img, furigana_filter_sensitivity=0):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        img_bytes, img_extension = self._preprocess(img)
        if not img_bytes:
            return (False, 'Image is too big!')

        data = {
            'apikey': self.api_key,
            'language': 'jpn'
        }
        files = {'file': ('image.' + img_extension, img_bytes, 'image/' + img_extension)}

        try:
            res = curl_cffi.post('https://api.ocr.space/parse/image', data=data, files=files, timeout=5)
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

        res = res['ParsedResults'][0]['ParsedText']
        x = (True, res)

        # img.close()
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
                            Analyze the image. Extract text \\*only\\* from within dialogue boxes (speech bubbles or panels containing character dialogue). If Text appears to be vertical, read the text from top to bottom, right to left. From the extracted dialogue text, filter out any furigana. Ignore and do not include any text found outside of dialogue boxes, including character names, speaker labels, or sound effects. Return \\*only\\* the filtered dialogue text. If no text is found within dialogue boxes after applying filters, return nothing. Do not include any other output, formatting markers, or commentary."
                            """
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

            return (True, text_output)

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
                return (True, text_output)
            else:
                return (True, "")

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
                return (True, text_output)
            else:
                return (True, "")
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
        global meiki_model
        try:
            if 'meikiocr' not in sys.modules:
                logger.warning('meikiocr not available, MeikiTextDetector will not work!')
                self.available = False
                return
            elif meiki_model:
                self.model = meiki_model
                self.available = True
                logger.info('MeikiOCR ready')
            else:
                logger.info('Initializing MeikiTextDetector using meikiocr package...')
                meiki_model = MKOCR()
                self.model = meiki_model
                self.available = True
                logger.info('MeikiTextDetector ready')
        except Exception as e:
            logger.warning(f'Error initializing MeikiTextDetector: {e}')
            self.available = False

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
    
    bing = Bing()
    
    re = bing(Image.open(r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\owocr\owocr\test_furigana.png"))
    
    print(re)
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
    #     # pixel suggestion: 5px absolute, and also ~5% of median min dimension
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
#     res, text = localOCR(Image.open(r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\owocr\owocr\test_furigana.png"))  # Example usage
#     end_time = time.time()

#     print(f"Time taken: {end_time - start_time:.2f} seconds")
#     print(text)
# class LocalOCR:
#     name = 'local_ocr'
#     readable_name = 'Local OCR'
#     key = '-'
#     available = False
#
#     def __init__(self, lang='ja'):
#         self.requests_session = requests.Session()
#         self.available = True
#         # logger.info('Local OCR ready') # Uncomment if you have a logger defined
#
#     def __call__(self, img, furigana_filter_sensitivity=0):
#         if not isinstance(img, Image.Image):
#             try:
#                 img = Image.open(io.BytesIO(img))
#             except Exception:
#                 return (False, 'Invalid image provided')
#
#         img = input_to_pil_image(img)
#
#         img_base64 = self._preprocess(img)
#         if not img_base64:
#             return (False, 'Image preprocessing failed (e.g., too big after resize)!')
#
#         api_url = 'http://localhost:2333/api/ocr'
#         # Send as JSON with base64 encoded image
#         json_data = {
#             'image': img_base64
#         }
#
#         try:
#             res = self.requests_session.post(api_url, json=json_data, timeout=5)
#             print(res.content)
#         except requests.exceptions.Timeout:
#             return (False, 'Request timeout!')
#         except requests.exceptions.ConnectionError:
#             return (False, 'Connection error!')
#
#         if res.status_code != 200:
#             return (False, f'Error: {res.status_code} - {res.text}')
#
#         try:
#             data = res.json()
#             # Assuming the local OCR service returns text in a 'text' key
#             extracted_text = data.get('text', '')
#             return (True, extracted_text)
#         except requests.exceptions.JSONDecodeError:
#             return (False, 'Invalid JSON response from OCR service!')
#
#     def _preprocess(self, img):
#         return base64.b64encode(pil_image_to_bytes(img, png_compression=1)).decode('utf-8')

# lens = GeminiOCR(config={'model': 'gemini-2.5-flash-lite-preview-06-17', 'api_key': ''})
#
# res, text = lens(Image.open('test_furigana.png'))  # Example usage
#
# print(text)