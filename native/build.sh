#!/bin/sh
set -eu
cd "$(dirname "$0")"
clang -O2 -arch arm64 -mmacosx-version-min=13.0 -Wall -Werror -o beacon-sensors beacon-sensors.c \
  -framework CoreFoundation -framework IOKit -lIOReport
digest=$(shasum -a 256 beacon-sensors | cut -d" " -f1)
{
  printf 'export const MAC_SENSORS_DIGEST = "%s";\n' "$digest"
  printf 'export const MAC_SENSORS_BINARY = "'
  base64 < beacon-sensors | tr -d '\n'
  printf '";\n'
} > ../lib/mac-sensors-binary.ts
rm beacon-sensors
echo "wrote lib/mac-sensors-binary.ts"
