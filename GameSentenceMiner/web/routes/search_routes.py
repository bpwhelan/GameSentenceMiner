"""
Search Routes

Routes for search operations:
- Search Jiten.moe
- Search VNDB
- Search AniList
- Unified search across all platforms
"""

import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Blueprint, request, jsonify

from GameSentenceMiner.util.clients.jiten_api_client import JitenApiClient
from GameSentenceMiner.util.config.configuration import logger

search_bp = Blueprint('search', __name__)


@search_bp.route("/api/jiten-search", methods=["GET"])
def api_jiten_search():
    """
    Search Jiten.moe dictionary entries
    ---
    tags:
      - Jiten
    parameters:
      - name: query
        in: query
        type: string
        required: true
        description: Search term
      - name: page
        in: query
        type: integer
        default: 1
        description: Page number
      - name: page_size
        in: query
        type: integer
        default: 20
        description: Results per page (max 100)
    responses:
      200:
        description: Search results
      400:
        description: Invalid search parameters
      500:
        description: Search failed
    """
    try:
        title_filter = request.args.get("title", "").strip()
        if not title_filter:
            return jsonify({"error": "Title parameter is required"}), 400

        # Use API client
        data = JitenApiClient.search_media_decks(title_filter)

        if not data:
            return jsonify({"error": "Failed to search jiten.moe database"}), 500

        # Process and format the results
        results = []
        for item in data.get("data", []):
            # Use the normalize function for consistency
            normalized_item = JitenApiClient.normalize_deck_data(item)
            results.append(normalized_item)

        return jsonify(
            {"results": results, "total_items": data.get("totalItems", 0)}
        ), 200

    except Exception as e:
        logger.debug(f"Error in jiten search: {e}")
        return jsonify({"error": "Search failed"}), 500


@search_bp.route("/api/search/unified", methods=["GET"])
def api_unified_search():
    """
    Search across Jiten, VNDB, and AniList simultaneously.
    
    Query Parameters:
    - q: Search query (required)
    - sources: Comma-separated list of sources (default: jiten,vndb,anilist)
    
    Returns:
    {
        "jiten": {"results": [...], "total": 10, "error": null},
        "vndb": {"results": [...], "total": 5, "error": null},
        "anilist": {"results": [...], "total": 8, "error": null}
    }
    """
    from GameSentenceMiner.util.clients.vndb_api_client import VNDBApiClient
    from GameSentenceMiner.util.clients.anilist_api_client import AniListApiClient
    
    # Constants
    SEARCH_TIMEOUT = 15  # seconds per source
    
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Query parameter 'q' is required"}), 400
    
    # Parse requested sources
    sources_param = request.args.get("sources", "jiten,vndb,anilist")
    requested_sources = [s.strip().lower() for s in sources_param.split(",")]
    
    # Initialize results structure
    results = {}
    
    def search_jiten():
        """Search Jiten.moe and normalize results"""
        try:
            logger.info(f"[Unified Search] Searching Jiten.moe for: '{query}'")
            data = JitenApiClient.search_media_decks(query)
            if not data:
                logger.warning(f"[Unified Search] Jiten.moe returned no data for: '{query}'")
                return {"results": [], "total": 0, "error": "Failed to fetch from Jiten.moe"}
            
            result_count = len(data.get("data", []))
            total_items = data.get("totalItems", 0)
            logger.info(f"[Unified Search] Jiten.moe returned {result_count} results for '{query}' (total: {total_items})")
            
            normalized_results = []
            for item in data.get("data", []):
                deck_data = JitenApiClient.normalize_deck_data(item)
                
                # Determine cover URL
                cover_url = None
                if deck_data.get("cover_name"):
                    cover_url = deck_data["cover_name"]
                
                normalized_results.append({
                    "id": str(deck_data.get("deck_id", "")),
                    "title": deck_data.get("title_original", ""),
                    "title_en": deck_data.get("title_english", ""),
                    "title_jp": deck_data.get("title_original", ""),
                    "cover_url": cover_url,
                    "source": "jiten",
                    "source_url": f"https://jiten.moe/decks/media/{deck_data.get('deck_id')}/detail",
                    "description": (deck_data.get("description", "") or "")[:200],
                    "media_type": deck_data.get("media_type_string", ""),
                    "character_count": deck_data.get("character_count", 0),
                    "difficulty": deck_data.get("difficulty", 0),
                    # Original data for linking
                    "_raw": deck_data
                })
            
            return {
                "results": normalized_results,
                "total": data.get("totalItems", len(normalized_results)),
                "error": None
            }
        except Exception as e:
            logger.error(f"Jiten search error: {e}")
            return {"results": [], "total": 0, "error": str(e)}
    
    def search_vndb():
        """Search VNDB and normalize results"""
        try:
            logger.info(f"[Unified Search] Searching VNDB for: '{query}'")
            data = VNDBApiClient.search_vn(query, limit=10)
            if not data:
                logger.warning(f"[Unified Search] VNDB returned no data for: '{query}'")
                return {"results": [], "total": 0, "error": "Failed to fetch from VNDB"}
            
            result_count = len(data.get("results", []))
            logger.info(f"[Unified Search] VNDB returned {result_count} results for '{query}'")
            
            normalized_results = []
            for item in data.get("results", []):
                # Extract cover URL from image object
                cover_url = None
                image_data = item.get("image")
                if isinstance(image_data, dict):
                    cover_url = image_data.get("url")
                
                # Extract developer names
                developers = item.get("developers", [])
                developer_names = []
                if developers:
                    developer_names = [d.get("name", "") for d in developers if d.get("name")]
                
                # Clean description
                description = item.get("description", "") or ""
                # Remove VNDB BBCode tags for display
                description = re.sub(r'\[/?[^\]]+\]', '', description)[:200]
                
                normalized_results.append({
                    "id": item.get("id", ""),
                    "title": item.get("title", ""),
                    "title_en": item.get("title", ""),  # VNDB title is usually romanized
                    "title_jp": item.get("alttitle", ""),
                    "cover_url": cover_url,
                    "source": "vndb",
                    "source_url": f"https://vndb.org/{item.get('id', '')}",
                    "description": description,
                    "media_type": "Visual Novel",
                    "rating": item.get("rating"),
                    "released": item.get("released"),
                    "developers": developer_names,
                    # Original data for potential linking
                    "_raw": item
                })
            
            return {
                "results": normalized_results,
                "total": len(normalized_results),
                "error": None
            }
        except Exception as e:
            logger.error(f"VNDB search error: {e}")
            return {"results": [], "total": 0, "error": str(e)}
    
    def search_anilist_anime():
        """Search AniList for anime and normalize results"""
        try:
            data = AniListApiClient.search_media(query, media_type="ANIME")
            if not data:
                return {"results": [], "total": 0, "error": "Failed to fetch from AniList"}
            
            media_list = data.get("data", {}).get("Page", {}).get("media", [])
            
            normalized_results = []
            for item in media_list:
                title_info = item.get("title", {})
                cover_info = item.get("coverImage", {})
                
                # Clean description - strip HTML and AniList spoiler tags
                description = item.get("description", "") or ""
                description = re.sub(r'<[^>]+>', '', description)  # Remove HTML
                description = re.sub(r'~!.+?!~', '', description, flags=re.DOTALL)  # Remove spoilers
                description = description[:200]
                
                normalized_results.append({
                    "id": str(item.get("id", "")),
                    "title": title_info.get("romaji", "") or title_info.get("english", ""),
                    "title_en": title_info.get("english", ""),
                    "title_jp": title_info.get("native", ""),
                    "cover_url": cover_info.get("large") or cover_info.get("medium"),
                    "source": "anilist",
                    "source_url": item.get("siteUrl", f"https://anilist.co/anime/{item.get('id')}"),
                    "description": description,
                    "media_type": "Anime",
                    "format": item.get("format"),
                    "status": item.get("status"),
                    "score": item.get("averageScore"),
                    "mal_id": item.get("idMal"),
                    # Original data for potential linking
                    "_raw": item
                })
            
            return {
                "results": normalized_results,
                "total": len(normalized_results),
                "error": None
            }
        except Exception as e:
            logger.error(f"AniList anime search error: {e}")
            return {"results": [], "total": 0, "error": str(e)}
    
    def search_anilist_manga():
        """Search AniList for manga and normalize results"""
        try:
            data = AniListApiClient.search_media(query, media_type="MANGA")
            if not data:
                return {"results": [], "total": 0, "error": "Failed to fetch from AniList"}
            
            media_list = data.get("data", {}).get("Page", {}).get("media", [])
            
            normalized_results = []
            for item in media_list:
                title_info = item.get("title", {})
                cover_info = item.get("coverImage", {})
                
                # Clean description
                description = item.get("description", "") or ""
                description = re.sub(r'<[^>]+>', '', description)
                description = re.sub(r'~!.+?!~', '', description, flags=re.DOTALL)
                description = description[:200]
                
                normalized_results.append({
                    "id": str(item.get("id", "")),
                    "title": title_info.get("romaji", "") or title_info.get("english", ""),
                    "title_en": title_info.get("english", ""),
                    "title_jp": title_info.get("native", ""),
                    "cover_url": cover_info.get("large") or cover_info.get("medium"),
                    "source": "anilist",
                    "source_url": item.get("siteUrl", f"https://anilist.co/manga/{item.get('id')}"),
                    "description": description,
                    "media_type": "Manga",
                    "format": item.get("format"),
                    "status": item.get("status"),
                    "score": item.get("averageScore"),
                    "mal_id": item.get("idMal"),
                    "_raw": item
                })
            
            return {
                "results": normalized_results,
                "total": len(normalized_results),
                "error": None
            }
        except Exception as e:
            logger.error(f"AniList manga search error: {e}")
            return {"results": [], "total": 0, "error": str(e)}
    
    # Map source names to search functions
    search_functions = {}
    if "jiten" in requested_sources:
        search_functions["jiten"] = search_jiten
    if "vndb" in requested_sources:
        search_functions["vndb"] = search_vndb
    if "anilist" in requested_sources:
        # AniList searches both anime and manga
        search_functions["anilist_anime"] = search_anilist_anime
        search_functions["anilist_manga"] = search_anilist_manga
    
    # Execute searches in parallel with timeout
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(func): name
            for name, func in search_functions.items()
        }
        
        for future in as_completed(futures, timeout=SEARCH_TIMEOUT + 5):
            source_name = futures[future]
            try:
                result = future.result(timeout=SEARCH_TIMEOUT)
                
                # Combine anime and manga results for AniList
                if source_name == "anilist_anime":
                    if "anilist" not in results:
                        results["anilist"] = {"results": [], "total": 0, "error": None}
                    results["anilist"]["results"].extend(result["results"])
                    results["anilist"]["total"] += result["total"]
                    if result["error"]:
                        results["anilist"]["error"] = result["error"]
                elif source_name == "anilist_manga":
                    if "anilist" not in results:
                        results["anilist"] = {"results": [], "total": 0, "error": None}
                    results["anilist"]["results"].extend(result["results"])
                    results["anilist"]["total"] += result["total"]
                    if result["error"] and not results["anilist"]["error"]:
                        results["anilist"]["error"] = result["error"]
                else:
                    results[source_name] = result
                    
            except TimeoutError:
                logger.warning(f"Search timeout for source: {source_name}")
                if source_name.startswith("anilist"):
                    if "anilist" not in results:
                        results["anilist"] = {"results": [], "total": 0, "error": "Timeout"}
                else:
                    results[source_name] = {"results": [], "total": 0, "error": "Timeout"}
            except Exception as e:
                logger.error(f"Search error for {source_name}: {e}")
                if source_name.startswith("anilist"):
                    if "anilist" not in results:
                        results["anilist"] = {"results": [], "total": 0, "error": str(e)}
                else:
                    results[source_name] = {"results": [], "total": 0, "error": str(e)}
    
    # Ensure all requested sources have entries in results
    for source in requested_sources:
        if source not in results:
            results[source] = {"results": [], "total": 0, "error": "No results"}
    
    # Combine all results into flat array for frontend compatibility
    all_results = []
    for source_name, source_data in results.items():
        all_results.extend(source_data.get("results", []))
    
    # Structure response to match frontend expectations
    response = {
        "results": all_results,
        "by_source": results,
        "query": query,
        "sources_searched": list(results.keys())
    }
    
    return jsonify(response), 200
