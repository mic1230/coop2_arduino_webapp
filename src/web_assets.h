#pragma once

#include <cstddef>
#include <cstdint>

struct EmbeddedAsset {
  const char *path;
  const char *contentType;
  const uint8_t *data;
  size_t size;
};

extern const EmbeddedAsset EMBEDDED_ASSETS[];
extern const size_t EMBEDDED_ASSET_COUNT;
