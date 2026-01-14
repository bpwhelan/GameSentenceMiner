# Jiten LinkType Reference

## Official Enum from Jiten.Core.Data

```csharp
namespace Jiten.Core.Data;

public enum LinkType
{
    Web = 1,
    Vndb = 2,
    Tmdb = 3,
    Anilist = 4,
    Mal = 5, // Myanimelist
    GoogleBooks = 6,
    Imdb = 7,
    Igdb = 8,
    Syosetsu = 9
}
```

## Python Implementation

```python
class JitenLinkType:
    """
    Jiten.moe external link types.
    Based on Jiten.Core.Data.LinkType enum.
    """
    WEB = 1
    VNDB = 2
    TMDB = 3
    ANILIST = 4
    MAL = 5  # MyAnimeList
    GOOGLE_BOOKS = 6
    IMDB = 7
    IGDB = 8
    SYOSETSU = 9
```

## API Usage

**Endpoint**: `https://api.jiten.moe/api/media-deck/by-link-id/{linkType}/{id}`

**Examples**:
- VNDB: `by-link-id/2/v17` (Steins;Gate)
- AniList: `by-link-id/4/149544` (某魔女という漫画)
- MyAnimeList: `by-link-id/5/12345`

## Integration Notes

### For Jiten Upgrader Cron

When checking if VNDB/AniList games exist on Jiten:
1. Extract `vndb_id` from game (e.g., "v17")
2. Call `/api/media-deck/by-link-id/2/v17`
3. If result is non-empty array, Jiten has this VN
4. Auto-link to Jiten using first deck_id in results
5. **Preserve** the vndb_id field for reference

Same process for AniList with LinkType 4.

### Schedule Configuration

- **Frequency**: Weekly
- **Day**: Sunday
- **Time**: 3:00 AM (server timezone)
- **Cron Expression**: `0 3 * * 0` (minute hour day month weekday)
