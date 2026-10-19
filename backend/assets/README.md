# Bundled Scripture data

`kjv.source.json` is the King James Version text from
[thiagobodruk/bible](https://github.com/thiagobodruk/bible/blob/master/json/en_kjv.json).
Only KJV is bundled; the repository's other translations are not included.
The original JSON is retained, and Lumen imports it into its local search index
without rewriting the verse text. See `kjv-source-license.txt` for the source
repository's license. Bible version imports must include their own attribution.

NKJV, NIV, NLT, Amplified, Good News, and TPT are supported as distinct library
editions, but their text must be supplied through an authorised digital import.
An uninstalled or incomplete edition is never silently replaced by KJV.
