# Japanese tag data

`danbooru_e621_merged_ja.csv` contains Japanese tag aliases derived from the
`boorutan/booru-japanese-tag` project. The file combines its machine-generated
tag list with the project's manually maintained aliases.

Source: https://github.com/boorutan/booru-japanese-tag

The upstream project is distributed under the MIT License. The Japanese
aliases are best-effort data; SAA keeps the original English tag as the prompt
and falls back to it when no Japanese alias is available.

`official_work_names.json` is a small SAA-maintained work-name dictionary. It
keeps recognizable work/franchise names in their official notation, including
Japan-standard localized names such as `ロックマン` where that is the more
familiar Japanese name.

Reviewed Japanese character-name corrections are stored directly in
`character_names.json`, so the file is the single source to edit when a name
needs correction. `scripts/reviewJapaneseCharacterNames.mjs` is the checked-in
maintenance script used to rebuild the entries for the current character list;
it applies curated Japanese names and conservative fallbacks without changing
the English generation tags.

Where a character has no sufficiently reliable Japanese official/common name,
the original name is intentionally retained instead of inventing a translation.
