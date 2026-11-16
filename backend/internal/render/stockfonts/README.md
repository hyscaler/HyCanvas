# Stock template fonts

The fonts the stock templates use, built into the server so exports it renders (video, PNG and JPEG through the API) draw those templates in their own fonts. See `../stockfonts.go`.

- Files are static TrueType instances from Google Fonts, gzipped, named `Family-Weight.ttf.gz` (family without spaces).
- Each family's license sits next to its faces as `Family.LICENSE.txt`. Every family is under the SIL Open Font License 1.1, the Apache License 2.0 or the Ubuntu Font License, all of which allow redistribution.
- `manifest.json` records each file's source URL, license and SHA-256 (of the uncompressed font).
- Regenerate with `node scripts/fetch-stock-fonts.mjs` after templates start using new fonts. Do not edit the files by hand.
