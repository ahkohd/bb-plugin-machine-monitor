#!/bin/sh
set -eu
cd "$(dirname "$0")"
clang -O2 -arch arm64 -mmacosx-version-min=13.0 -Wall -Werror -o sensors sensors.c \
  -framework CoreFoundation -framework IOKit -lIOReport
digest=$(shasum -a 256 sensors | cut -d" " -f1)
{
  printf 'export const MAC_SENSORS_DIGEST = "%s";\n' "$digest"
  printf 'export const MAC_SENSORS_BINARY = "'
  base64 < sensors | tr -d '\n'
  printf '";\n'
} > ../lib/mac-sensors-binary.ts
rm sensors
echo "wrote lib/mac-sensors-binary.ts"
