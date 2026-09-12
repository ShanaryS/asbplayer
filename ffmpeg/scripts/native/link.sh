#!/bin/bash
set -euo pipefail

emcc \
    -I. -I./src/fftools \
    -Llibavcodec -Llibavfilter -Llibavformat -Llibavutil \
    -lavcodec -lavfilter -lavformat -lavutil \
    -Wno-deprecated-declarations \
    -Oz \
    -sENVIRONMENT=worker \
    -sWASM_BIGINT \
    -sMODULARIZE \
    -sEXPORT_ES6 \
    -sINITIAL_MEMORY=32MB \
    -sALLOW_MEMORY_GROWTH \
    -sDYNAMIC_EXECUTION=0 \
    -sFILESYSTEM=1 \
    -sEXPORT_NAME=createFFmpegCore \
    -sEXPORTED_FUNCTIONS="$(node src/bind/ffmpeg/export.js)" \
    -sEXPORTED_RUNTIME_METHODS="$(node src/bind/ffmpeg/export-runtime.js)" \
    -lworkerfs.js \
    --pre-js src/bind/ffmpeg/bind.js \
    -Wl,-Map=/output/ffmpeg-core.map \
    src/fftools/cmdutils.c \
    src/fftools/ffmpeg.c \
    src/fftools/ffmpeg_filter.c \
    src/fftools/ffmpeg_hw.c \
    src/fftools/ffmpeg_mux.c \
    src/fftools/ffmpeg_opt.c \
    src/fftools/opt_common.c \
    -o /output/ffmpeg-core.js
