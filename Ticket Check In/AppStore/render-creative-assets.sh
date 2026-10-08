#!/bin/sh
# Renders creative-assets.html to the App Store Connect "creative assets" PNGs.
#   header.png  3840 x 1646  product page header
#   search.png  3840 x 2560  search results
# Apple rejects images with an alpha channel, so each render is flattened to RGB.
# Pass --guides to also write *-guides.png with the safe area outlined in red.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SRC="file://$(pwd)/creative-assets.html"

render() { # name width height query
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
        --window-size="$2,$3" --screenshot="$(pwd)/$1.png" "$SRC?$4" >/dev/null 2>&1
    python3 -c "from PIL import Image; import sys; p=sys.argv[1]; Image.open(p).convert('RGB').save(p, optimize=True)" "$1.png"
    echo "$1.png  $(python3 -c "from PIL import Image; import sys; i=Image.open(sys.argv[1]); print(i.size, i.mode)" "$1.png")"
}

render header 3840 1646 "asset=header"
render search 3840 2560 "asset=search"
if [ "$1" = "--guides" ]; then
    render header-guides 3840 1646 "asset=header&guides=1"
    render search-guides 3840 2560 "asset=search&guides=1"
fi
