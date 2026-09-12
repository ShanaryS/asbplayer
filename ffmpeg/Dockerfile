FROM emscripten/emsdk@sha256:c1e807a6e03ac5bd5b37bae2ace3c46c08579e2ddeb951037a3b8dac7067f2cc

COPY .cache/sources/ffmpeg /src
COPY .cache/sources/ffmpeg-wasm/src/bind /src/src/bind
COPY .cache/sources/ffmpeg-wasm/src/fftools /src/src/fftools
COPY scripts/native/bind.js /src/src/bind/ffmpeg/bind.js
COPY scripts/native/export.js /src/src/bind/ffmpeg/export.js
COPY scripts/native/link.sh /src/asbplayer-link.sh

WORKDIR /src
RUN mkdir -p /output \
    && emconfigure ./configure \
        --target-os=none \
        --arch=x86_32 \
        --enable-cross-compile \
        --disable-asm \
        --disable-stripping \
        --disable-everything \
        --disable-autodetect \
        --disable-programs \
        --disable-doc \
        --disable-debug \
        --disable-network \
        --disable-runtime-cpudetect \
        --disable-pthreads \
        --disable-w32threads \
        --disable-os2threads \
        --disable-gpl \
        --disable-nonfree \
        --disable-version3 \
        --enable-static \
        --disable-shared \
        --enable-small \
        --disable-avdevice \
        --disable-postproc \
        --disable-swresample \
        --disable-swscale \
        --extra-version=asbplayer-ffmpeg-0.1.0 \
        --nm=emnm \
        --ar=emar \
        --ranlib=emranlib \
        --cc=emcc \
        --cxx=em++ \
        --objcc=emcc \
        --dep-cc=emcc \
        --pkg-config=/usr/bin/false \
    && cp ffbuild/config.mak /output/config.mak \
    && emmake make -j"$(nproc)" \
    && bash /src/asbplayer-link.sh

FROM scratch
COPY --from=0 /output /
COPY --from=0 /emsdk/upstream/emscripten/LICENSE /emscripten-LICENSE.txt
