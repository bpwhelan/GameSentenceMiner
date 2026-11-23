UPDATE games
SET character_summary = NULL
WHERE ltrim(character_summary, ' ' || char(9) || char(10) || char(13))
        GLOB 'Processing failed:*'
    OR trim(character_summary) = 'Invalid input.';
