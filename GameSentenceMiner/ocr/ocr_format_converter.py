"""
OCR Format Converter Utility

Provides unified conversion from various OCR engine output formats to a standardized format
that can be used across the application (overlay, furigana filter, etc.).
"""

from typing import List, Dict, Any, Tuple, Optional

from GameSentenceMiner.util.config.configuration import logger


def convert_ocr_result_to_unified_format(
    ocr_result: Any,
    engine_name: str = "unknown"
) -> Optional[List[Dict[str, Any]]]:
    """
    Converts OCR results from various engines to a unified format.
    
    Args:
        ocr_result: The raw result from an OCR engine
        engine_name: Name of the OCR engine for logging purposes
        
    Returns:
        A list of dictionaries with standardized format:
        [
            {
                'text': str,
                'bounding_rect': {
                    'x1': float, 'y1': float, 'x2': float, 'y2': float,
                    'x3': float, 'y3': float, 'x4': float, 'y4': float,
                    'width': float, 'height': float
                },
                'height': float,
                'words': [...]  # optional, for engines that provide word-level data
            },
            ...
        ]
        Returns None if the result cannot be converted.
    """
    if not ocr_result:
        logger.debug(f"convert_ocr_result_to_unified_format: {engine_name} result is empty/None")
        return None
    
    try:
        # Handle 6-element tuple format (OneOCR, MeikiOCR, GoogleLens with return_coords=True)
        if isinstance(ocr_result, tuple) and len(ocr_result) == 6:
            success, element1, element2, crop_coords_list, crop_coords, response_dict = ocr_result
            
            if not success:
                logger.debug(f"convert_ocr_result_to_unified_format: {engine_name} reported failure")
                return None
            
            # For GoogleLens: element1=text_list, element2=coords, response_dict has full data
            # For OneOCR/MeikiOCR: element1=full_text, element2=filtered_lines, response_dict has full data
            
            # If element2 is already a list of dicts with the right structure, use it
            if isinstance(element2, list) and len(element2) > 0:
                if isinstance(element2[0], dict) and 'bounding_rect' in element2[0]:
                    logger.debug(f"convert_ocr_result_to_unified_format: {engine_name} - Using filtered_lines directly (element2)")
                    return element2
            
            # For MeikiOCR/OneOCR with return_dict=True and no furigana filter, 
            # element2 might be None and data is in response_dict['lines']
            if isinstance(response_dict, dict) and 'lines' in response_dict:
                lines = response_dict.get('lines', [])
                if lines and isinstance(lines[0], dict) and 'bounding_rect' in lines[0]:
                    logger.debug(f"convert_ocr_result_to_unified_format: {engine_name} - Using lines from response_dict")
                    return lines
            
            # Otherwise, try to extract from response_dict (typical for GoogleLens)
            if isinstance(response_dict, dict):
                extracted = extract_from_api_response(response_dict, engine_name)
                if extracted:
                    return extracted
            
            logger.warning(f"convert_ocr_result_to_unified_format: {engine_name} - Could not extract data from 6-tuple")
            return None
        
        # Handle list of dicts (already in unified format)
        if isinstance(ocr_result, list):
            if len(ocr_result) == 0:
                logger.debug(f"convert_ocr_result_to_unified_format: {engine_name} returned empty list")
                return None
            if isinstance(ocr_result[0], dict) and 'bounding_rect' in ocr_result[0]:
                logger.debug(f"convert_ocr_result_to_unified_format: {engine_name} - Already in unified format")
                return ocr_result
            
            # Try to extract if it's a list of API responses
            logger.debug(f"convert_ocr_result_to_unified_format: {engine_name} - List format not recognized")
            return None
        
        # Handle dict (might be API response)
        if isinstance(ocr_result, dict):
            extracted = extract_from_api_response(ocr_result, engine_name)
            if extracted:
                return extracted
        
        logger.warning(f"convert_ocr_result_to_unified_format: {engine_name} - Unrecognized format: {type(ocr_result)}")
        return None
        
    except Exception as e:
        logger.exception(f"convert_ocr_result_to_unified_format: Error converting {engine_name} result: {e}")
        return None


def extract_from_api_response(
    api_response: Dict[str, Any],
    engine_name: str = "unknown"
) -> Optional[List[Dict[str, Any]]]:
    """
    Extracts text and bounding boxes from API response dictionaries.
    Handles both GoogleLens and other API formats.
    
    Args:
        api_response: Dictionary containing API response
        engine_name: Name of the engine for logging
        
    Returns:
        List of standardized dictionaries or None
    """
    try:
        # GoogleLens protobuf format: has 'objects_response' -> 'text' -> 'text_layout' -> 'paragraphs'
        if 'objects_response' in api_response:
            return extract_from_google_lens_protobuf_response(api_response)
        
        # GoogleLens JSON format: has 'textAnnotations'
        if 'textAnnotations' in api_response:
            return extract_from_google_lens_json_response(api_response)
        
        # Check for other common API formats
        # Add more extraction methods here as needed
        
        logger.debug(f"extract_from_api_response: {engine_name} - API format not recognized")
        return None
        
    except Exception as e:
        logger.exception(f"extract_from_api_response: Error extracting from {engine_name}: {e}")
        return None


def extract_from_google_lens_protobuf_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Extracts text and coordinates from Google Lens protobuf API response.
    
    The Google Lens protobuf response contains objects_response -> text -> text_layout -> paragraphs
    with normalized coordinates (0-1 range).
    """
    results = []
    
    try:
        # Navigate through the nested structure
        text_data = response.get('objects_response', {}).get('text', {})
        text_layout = text_data.get('text_layout', {})
        paragraphs = text_layout.get('paragraphs', [])
        
        if not paragraphs:
            logger.debug("extract_from_google_lens_protobuf_response: No paragraphs found")
            return None
        
        for paragraph in paragraphs:
            for line in paragraph.get('lines', []):
                # Get text from words
                words = line.get('words', [])
                line_text = ''.join([w.get('plain_text', '') + w.get('text_separator', '') for w in words])
                
                if not line_text.strip():
                    continue
                
                # Get bounding box - normalized coordinates (0-1 range)
                line_bbox = line.get('geometry', {}).get('bounding_box', {})
                if not line_bbox:
                    continue
                
                # Lens uses center_x, center_y, width, height (normalized)
                center_x = line_bbox.get('center_x', 0)
                center_y = line_bbox.get('center_y', 0)
                width = line_bbox.get('width', 0)
                height = line_bbox.get('height', 0)
                
                # Calculate corner coordinates (normalized)
                half_width = width / 2
                half_height = height / 2
                x1 = center_x - half_width
                y1 = center_y - half_height
                x2 = center_x + half_width
                y2 = center_y - half_height
                x3 = center_x + half_width
                y3 = center_y + half_height
                x4 = center_x - half_width
                y4 = center_y + half_height
                
                # Create bounding_rect in the expected format
                bounding_rect = {
                    'x1': x1, 'y1': y1,
                    'x2': x2, 'y2': y2,
                    'x3': x3, 'y3': y3,
                    'x4': x4, 'y4': y4,
                    'width': width,
                    'height': height
                }
                
                results.append({
                    'text': line_text.strip(),
                    'bounding_rect': bounding_rect,
                    'height': height,
                    'normalized': True  # Flag to indicate coordinates are normalized
                })
        
        logger.debug(f"extract_from_google_lens_protobuf_response: Extracted {len(results)} text lines")
        return results if results else None
        
    except Exception as e:
        logger.exception(f"extract_from_google_lens_protobuf_response: Error extracting: {e}")
        return None


def extract_from_google_lens_json_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Extracts text and coordinates from Google Lens JSON API response (alternative format).
    
    The Google Lens response contains textAnnotations with paragraphs that have
    normalized coordinates (0-1 range).
    """
    results = []
    
    try:
        text_annotations = response.get('textAnnotations', [])
        if not text_annotations:
            logger.debug("extract_from_google_lens_json_response: No textAnnotations found")
            return None
        
        for annotation in text_annotations:
            if not isinstance(annotation, dict):
                continue
                
            # Get text
            text = annotation.get('text', '')
            if not text:
                continue
            
            # Get bounding box - Lens uses normalized coordinates (0-1 range)
            bounding_box = annotation.get('boundingBox', {})
            if not bounding_box:
                continue
            
            # Extract normalized coordinates
            # Lens format typically has normalizedVertices with x, y values between 0-1
            normalized_vertices = bounding_box.get('normalizedVertices', [])
            if len(normalized_vertices) < 4:
                continue
            
            # Create bounding_rect in the expected format
            # Note: These are normalized coordinates (0-1 range)
            # The consumer needs to multiply by image dimensions
            bounding_rect = {
                'x1': normalized_vertices[0].get('x', 0),
                'y1': normalized_vertices[0].get('y', 0),
                'x2': normalized_vertices[1].get('x', 0),
                'y2': normalized_vertices[1].get('y', 0),
                'x3': normalized_vertices[2].get('x', 0),
                'y3': normalized_vertices[2].get('y', 0),
                'x4': normalized_vertices[3].get('x', 0),
                'y4': normalized_vertices[3].get('y', 0),
                'width': abs(normalized_vertices[1].get('x', 0) - normalized_vertices[0].get('x', 0)),
                'height': abs(normalized_vertices[3].get('y', 0) - normalized_vertices[0].get('y', 0))
            }
            
            # Calculate height (in normalized space)
            height = bounding_rect['height']
            
            results.append({
                'text': text,
                'bounding_rect': bounding_rect,
                'height': height,
                'normalized': True  # Flag to indicate coordinates are normalized
            })
        
        logger.debug(f"extract_from_google_lens_json_response: Extracted {len(results)} text regions")
        return results if results else None
        
    except Exception as e:
        logger.exception(f"extract_from_google_lens_json_response: Error extracting: {e}")
        return None


def convert_normalized_coords_to_pixels(
    lines: List[Dict[str, Any]],
    img_width: int,
    img_height: int
) -> List[Dict[str, Any]]:
    """
    Converts normalized coordinates (0-1 range) to pixel coordinates.
    
    Args:
        lines: List of line dictionaries with normalized coordinates
        img_width: Image width in pixels
        img_height: Image height in pixels
        
    Returns:
        List of line dictionaries with pixel coordinates
    """
    converted_lines = []
    
    for line in lines:
        if not line.get('normalized', False):
            # Already in pixel coordinates
            converted_lines.append(line)
            continue
        
        # Create a copy to avoid modifying original
        converted_line = line.copy()
        bounding_rect = line['bounding_rect'].copy()
        
        # Convert each coordinate
        for key in ['x1', 'x2', 'x3', 'x4']:
            if key in bounding_rect:
                bounding_rect[key] = bounding_rect[key] * img_width
        
        for key in ['y1', 'y2', 'y3', 'y4']:
            if key in bounding_rect:
                bounding_rect[key] = bounding_rect[key] * img_height
        
        # Convert width and height
        if 'width' in bounding_rect:
            bounding_rect['width'] = bounding_rect['width'] * img_width
        if 'height' in bounding_rect:
            bounding_rect['height'] = bounding_rect['height'] * img_height
        
        # Update the line
        converted_line['bounding_rect'] = bounding_rect
        converted_line['height'] = bounding_rect.get('height', 0)
        converted_line['normalized'] = False
        
        converted_lines.append(converted_line)
    
    return converted_lines
