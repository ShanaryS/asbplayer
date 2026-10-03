#include "asb-build-config.hpp"
#include "include/asb_ffmpeg.h"
#include "json.hpp"

#include <emscripten.h>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/avutil.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>

// The worker owns a bounded File/Blob reader. Offsets stay doubles at the JS boundary,
// preserving safe integer positions beyond 4 GiB without allocating the input in WASM.
EM_JS(int, asb_read_input, (double offset, uint8_t* buffer, int length), {
    return Module['asbReadInput'](offset, buffer, length);
});

EM_JS(void, asb_report_progress, (double processed_seconds, double total_seconds, int finalizing), {
    Module['asbReportProgress'](processed_seconds, total_seconds, finalizing);
});

namespace {
std::string last_error;

int fail(const char* operation, int error) {
    char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(error, buffer, sizeof(buffer));
    last_error = std::string(operation) + ": " + buffer;
    return -1;
}

struct InputBuffer {
    int64_t size;
    int64_t position = 0;
};

int read_input(void* opaque, uint8_t* buffer, int buffer_size) {
    auto* input = static_cast<InputBuffer*>(opaque);
    if (input->position >= input->size) return AVERROR_EOF;
    const int count = static_cast<int>(std::min<int64_t>(32768, std::min<int64_t>(buffer_size, input->size - input->position)));
    const int read = asb_read_input(static_cast<double>(input->position), buffer, count);
    if (read <= 0 || read > count) return AVERROR(EIO);
    input->position += read;
    return read;
}

int64_t seek_input(void* opaque, int64_t offset, int whence) {
    auto* input = static_cast<InputBuffer*>(opaque);
    const int mode = whence & ~AVSEEK_FORCE;
    if (mode == AVSEEK_SIZE) return input->size;
    int64_t base = 0;
    if (mode == SEEK_CUR) base = input->position;
    else if (mode == SEEK_END) base = input->size;
    else if (mode != SEEK_SET) return AVERROR(EINVAL);
    if (offset < -base || offset > input->size - base) return AVERROR(EINVAL);
    input->position = base + offset;
    return input->position;
}

std::string runtime_info() {
    std::string output = "{\"runtimeVersion\":\"" ASB_RUNTIME_VERSION "\",\"ffmpegVersion\":";
    asb::append_json_string(output, av_version_info());
    output += ",\"ffmpegConfiguration\":";
    asb::append_json_string(output, avutil_configuration());
    output += ",\"ffmpegLicense\":";
    asb::append_json_string(output, avutil_license());
    output += ",\"linkedLibraries\":[\"libavutil\",\"libavcodec\",\"libavformat\",\"libswresample\"],\"libraries\":[";
    output += "{\"name\":\"libavutil\",\"version\":" + std::to_string(avutil_version()) + ",\"configuration\":";
    asb::append_json_string(output, avutil_configuration());
    output += ",\"license\":";
    asb::append_json_string(output, avutil_license());
    output += "},{\"name\":\"libavcodec\",\"version\":" + std::to_string(avcodec_version()) + ",\"configuration\":";
    asb::append_json_string(output, avcodec_configuration());
    output += ",\"license\":";
    asb::append_json_string(output, avcodec_license());
    output += "},{\"name\":\"libavformat\",\"version\":" + std::to_string(avformat_version()) + ",\"configuration\":";
    asb::append_json_string(output, avformat_configuration());
    output += ",\"license\":";
    asb::append_json_string(output, avformat_license());
    output += "},{\"name\":\"libswresample\",\"version\":" + std::to_string(swresample_version()) + ",\"configuration\":";
    asb::append_json_string(output, swresample_configuration());
    output += ",\"license\":";
    asb::append_json_string(output, swresample_license());
    output += "}],\"operations\":[\"inspect\",\"transcodeAudio\"]}";
    return output;
}

int prepare_frame(AVFrame* frame, AVCodecContext* encoder, int samples) {
    av_frame_unref(frame);
    frame->format = encoder->sample_fmt;
    frame->sample_rate = encoder->sample_rate;
    frame->nb_samples = samples;
    const int result = av_channel_layout_copy(&frame->ch_layout, &encoder->ch_layout);
    return result < 0 ? result : av_frame_get_buffer(frame, 0);
}

struct Transcoder {
    AVFormatContext* input = nullptr;
    AVIOContext* input_io = nullptr;
    AVCodecContext* decoder = nullptr;
    AVCodecContext* encoder = nullptr;
    AVFormatContext* output = nullptr;
    SwrContext* resampler = nullptr;
    AVAudioFifo* fifo = nullptr;
    AVFrame* decoded = nullptr;
    AVFrame* converted = nullptr;
    AVFrame* encoded = nullptr;
    AVPacket* packet = nullptr;
    AVPacket* encoded_packet = nullptr;
    AVStream* input_stream = nullptr;
    int64_t origin = 0;
    int64_t written_samples = 0;
    int64_t next_pts = 0;
    double total_seconds = 0;
    double last_progress_report = 0;
    bool finalizing = false;

    void report_progress(bool force = false) {
        const double now = emscripten_get_now();
        if (!force && now - last_progress_report < 250) return;
        last_progress_report = now;
        asb_report_progress(static_cast<double>(next_pts) / encoder->sample_rate, total_seconds, finalizing ? 1 : 0);
    }

    ~Transcoder() {
        if (output != nullptr && output->pb != nullptr) {
            uint8_t* bytes = nullptr;
            avio_close_dyn_buf(output->pb, &bytes);
            av_free(bytes);
        }
        av_packet_free(&encoded_packet);
        av_packet_free(&packet);
        av_frame_free(&encoded);
        av_frame_free(&converted);
        av_frame_free(&decoded);
        av_audio_fifo_free(fifo);
        swr_free(&resampler);
        avcodec_free_context(&encoder);
        avcodec_free_context(&decoder);
        avformat_free_context(output);
        if (input != nullptr) {
            input->pb = nullptr;
            avformat_close_input(&input);
        }
        if (input_io != nullptr) {
            av_freep(&input_io->buffer);
            avio_context_free(&input_io);
        }
    }

    int drain_encoder() {
        int result;
        while ((result = avcodec_receive_packet(encoder, encoded_packet)) >= 0) {
            av_packet_rescale_ts(encoded_packet, encoder->time_base, output->streams[0]->time_base);
            encoded_packet->stream_index = 0;
            result = av_interleaved_write_frame(output, encoded_packet);
            av_packet_unref(encoded_packet);
            if (result < 0) return result;
        }
        return result == AVERROR(EAGAIN) || result == AVERROR_EOF ? 0 : result;
    }

    int encode_pending(bool final = false) {
        while (av_audio_fifo_size(fifo) >= encoder->frame_size || (final && av_audio_fifo_size(fifo) > 0)) {
            const int samples = std::min(av_audio_fifo_size(fifo), encoder->frame_size);
            int result = prepare_frame(encoded, encoder, samples);
            if (result < 0) return result;
            if (av_audio_fifo_read(fifo, reinterpret_cast<void**>(encoded->extended_data), samples) != samples)
                return AVERROR(EIO);
            encoded->pts = next_pts;
            next_pts += samples;
            result = avcodec_send_frame(encoder, encoded);
            if (result < 0) return result;
            result = drain_encoder();
            if (result < 0) return result;
            report_progress();
        }
        return 0;
    }

    int append_samples(AVFrame* frame, int offset, int count) {
        if (count == 0) return 0;
        const int channels = encoder->ch_layout.nb_channels;
        const bool planar = av_sample_fmt_is_planar(encoder->sample_fmt);
        const int stride = av_get_bytes_per_sample(encoder->sample_fmt) * (planar ? 1 : channels);
        uint8_t* planes[AV_NUM_DATA_POINTERS] = {};
        for (int channel = 0; channel < (planar ? channels : 1); ++channel)
            planes[channel] = frame->extended_data[channel] + offset * stride;
        int result = av_audio_fifo_realloc(fifo, av_audio_fifo_size(fifo) + count);
        if (result < 0) return result;
        if (av_audio_fifo_write(fifo, reinterpret_cast<void**>(planes), count) != count) return AVERROR(EIO);
        written_samples += count;
        return encode_pending();
    }

    int append_silence(int64_t samples) {
        while (samples > 0) {
            const int count = static_cast<int>(std::min<int64_t>(samples, encoder->frame_size));
            int result = prepare_frame(encoded, encoder, count);
            if (result < 0) return result;
            result = av_samples_set_silence(encoded->extended_data, 0, count, encoder->ch_layout.nb_channels,
                                           encoder->sample_fmt);
            if (result < 0) return result;
            result = append_samples(encoded, 0, count);
            if (result < 0) return result;
            samples -= count;
        }
        return 0;
    }

    int convert_frame() {
        const int64_t delay = swr_get_delay(resampler, decoder->sample_rate);
        const int capacity = static_cast<int>(av_rescale_rnd(delay + decoded->nb_samples,
            encoder->sample_rate, decoder->sample_rate, AV_ROUND_UP));
        int result = prepare_frame(converted, encoder, capacity);
        if (result < 0) return result;
        const int samples = swr_convert(resampler, converted->extended_data, capacity,
            const_cast<const uint8_t**>(decoded->extended_data), decoded->nb_samples);
        if (samples < 0) return samples;
        if (samples == 0) return 0;

        // Reconcile packet timestamps with the media timeline. Allow one timestamp tick of
        // rounding (e.g. Matroska milliseconds), while retaining real offsets and gaps.
        int64_t target = written_samples;
        const int64_t timestamp = decoded->best_effort_timestamp;
        if (timestamp != AV_NOPTS_VALUE) {
            target = av_rescale_q(timestamp, input_stream->time_base, encoder->time_base) - origin
                - av_rescale_q(delay, AVRational{1, decoder->sample_rate}, encoder->time_base);
        }
        const int64_t tolerance = std::max<int64_t>(1, av_rescale_q(1, input_stream->time_base, encoder->time_base));
        const int64_t difference = target - written_samples;
        if (difference > tolerance) {
            result = append_silence(difference);
            if (result < 0) return result;
        }
        const int skip = difference < -tolerance ? static_cast<int>(std::min<int64_t>(-difference, samples)) : 0;
        return append_samples(converted, skip, samples - skip);
    }

    int receive_frames() {
        int result;
        while ((result = avcodec_receive_frame(decoder, decoded)) >= 0) {
            result = convert_frame();
            if (result < 0) return result;
        }
        return result == AVERROR(EAGAIN) || result == AVERROR_EOF ? 0 : result;
    }

    int finish() {
        int result = avcodec_send_packet(decoder, nullptr);
        if (result < 0 && result != AVERROR_EOF) return result;
        result = receive_frames();
        if (result < 0) return result;
        while (true) {
            const int capacity = static_cast<int>(av_rescale_rnd(swr_get_delay(resampler, decoder->sample_rate),
                encoder->sample_rate, decoder->sample_rate, AV_ROUND_UP));
            if (capacity <= 0) break;
            result = prepare_frame(converted, encoder, capacity);
            if (result < 0) return result;
            const int samples = swr_convert(resampler, converted->extended_data, capacity, nullptr, 0);
            if (samples < 0) return samples;
            if (samples == 0) break;
            result = append_samples(converted, 0, samples);
            if (result < 0) return result;
        }
        result = encode_pending(true);
        if (result < 0) return result;
        result = avcodec_send_frame(encoder, nullptr);
        if (result < 0) return result;
        result = drain_encoder();
        return result < 0 ? result : av_write_trailer(output);
    }
};
} // namespace

extern "C" const char* asb_runtime_info_json(void) noexcept {
    static const std::string info = runtime_info();
    return info.c_str();
}

extern "C" const char* asb_last_error(void) noexcept { return last_error.c_str(); }
extern "C" void asb_free(void* pointer) noexcept { av_free(pointer); }

extern "C" int asb_transcode_audio(double input_size, int track_index,
                                  unsigned int* output_pointer, unsigned int* output_size) noexcept {
    if (!std::isfinite(input_size) || input_size <= 0 || input_size > 9007199254740991.0 ||
        std::floor(input_size) != input_size || output_pointer == nullptr || output_size == nullptr || track_index < 0)
        return fail("Invalid audio transcode arguments", AVERROR(EINVAL));
    *output_pointer = 0;
    *output_size = 0;
    last_error.clear();
    InputBuffer input_buffer{static_cast<int64_t>(input_size)};
    Transcoder transcode;
    auto* io_buffer = static_cast<uint8_t*>(av_malloc(32768));
    if (io_buffer == nullptr) return fail("Unable to allocate FFmpeg input buffer", AVERROR(ENOMEM));
    transcode.input_io = avio_alloc_context(io_buffer, 32768, 0, &input_buffer, read_input, nullptr, seek_input);
    if (transcode.input_io == nullptr) {
        av_free(io_buffer);
        return fail("Unable to create FFmpeg input context", AVERROR(ENOMEM));
    }
    transcode.input = avformat_alloc_context();
    if (transcode.input == nullptr) return fail("Unable to allocate FFmpeg input format", AVERROR(ENOMEM));
    transcode.input->pb = transcode.input_io;
    transcode.input->flags |= AVFMT_FLAG_CUSTOM_IO;
    int result = avformat_open_input(&transcode.input, nullptr, nullptr, nullptr);
    if (result < 0) return fail("Could not open input", result);
    int audio_count = 0;
    for (unsigned int index = 0; index < transcode.input->nb_streams; ++index) {
        auto* stream = transcode.input->streams[index];
        if (stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO && audio_count++ == track_index) {
            transcode.input_stream = stream;
        } else {
            stream->discard = AVDISCARD_ALL;
            // Stream probing copies codec data into temporary decoder contexts.
            // In particular, font attachments can exhaust WASM memory this way.
            av_freep(&stream->codecpar->extradata);
            stream->codecpar->extradata_size = 0;
        }
    }
    if (transcode.input_stream == nullptr) return fail("The requested audio track does not exist", AVERROR(EINVAL));
    result = avformat_find_stream_info(transcode.input, nullptr);
    if (result < 0) return fail("Could not read input stream information", result);
    const auto* decoder_codec = avcodec_find_decoder(transcode.input_stream->codecpar->codec_id);
    if (decoder_codec == nullptr) return fail("The selected audio codec is not available", AVERROR_DECODER_NOT_FOUND);
    transcode.decoder = avcodec_alloc_context3(decoder_codec);
    if (transcode.decoder == nullptr) return fail("Unable to allocate the audio decoder", AVERROR(ENOMEM));
    result = avcodec_parameters_to_context(transcode.decoder, transcode.input_stream->codecpar);
    if (result < 0) return fail("Could not configure audio decoder", result);
    transcode.decoder->pkt_timebase = transcode.input_stream->time_base;
    result = avcodec_open2(transcode.decoder, decoder_codec, nullptr);
    if (result < 0) return fail("Could not open audio decoder", result);
    result = avformat_alloc_output_context2(&transcode.output, nullptr, "mp4", nullptr);
    if (result < 0 || transcode.output == nullptr) return fail("Could not create audio output", result < 0 ? result : AVERROR(ENOMEM));
    const auto* encoder_codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (encoder_codec == nullptr) return fail("The AAC encoder is not available", AVERROR_ENCODER_NOT_FOUND);
    auto* output_stream = avformat_new_stream(transcode.output, nullptr);
    transcode.encoder = avcodec_alloc_context3(encoder_codec);
    if (output_stream == nullptr || transcode.encoder == nullptr) return fail("Unable to allocate the audio encoder", AVERROR(ENOMEM));
    auto* encoder = transcode.encoder;
    encoder->codec_type = AVMEDIA_TYPE_AUDIO;
    encoder->codec_id = AV_CODEC_ID_AAC;
    encoder->sample_rate = transcode.decoder->sample_rate == 44100 ? 44100 : 48000;
    encoder->sample_fmt = AV_SAMPLE_FMT_FLTP;
    encoder->bit_rate = 128000;
    av_channel_layout_default(&encoder->ch_layout, 2);
    encoder->time_base = AVRational{1, encoder->sample_rate};
    if (transcode.output->oformat->flags & AVFMT_GLOBALHEADER) encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    result = avcodec_open2(encoder, encoder_codec, nullptr);
    if (result < 0) return fail("Could not open AAC encoder", result);
    result = avcodec_parameters_from_context(output_stream->codecpar, encoder);
    if (result < 0) return fail("Could not configure audio output", result);
    output_stream->time_base = encoder->time_base;
    result = avio_open_dyn_buf(&transcode.output->pb);
    if (result < 0) return fail("Could not allocate audio output buffer", result);
    result = avformat_write_header(transcode.output, nullptr);
    if (result < 0) return fail("Could not write audio output header", result);
    result = swr_alloc_set_opts2(&transcode.resampler, &encoder->ch_layout, encoder->sample_fmt, encoder->sample_rate,
        &transcode.decoder->ch_layout, transcode.decoder->sample_fmt, transcode.decoder->sample_rate, 0, nullptr);
    if (result < 0) return fail("Could not configure audio resampling", result);
    result = swr_init(transcode.resampler);
    if (result < 0) return fail("Could not initialize audio resampling", result);
    transcode.fifo = av_audio_fifo_alloc(encoder->sample_fmt, encoder->ch_layout.nb_channels, encoder->frame_size);
    transcode.decoded = av_frame_alloc();
    transcode.converted = av_frame_alloc();
    transcode.encoded = av_frame_alloc();
    transcode.packet = av_packet_alloc();
    transcode.encoded_packet = av_packet_alloc();
    if (transcode.fifo == nullptr || transcode.decoded == nullptr || transcode.converted == nullptr ||
        transcode.encoded == nullptr || transcode.packet == nullptr || transcode.encoded_packet == nullptr)
        return fail("Unable to allocate audio frames", AVERROR(ENOMEM));
    if (transcode.input->start_time != AV_NOPTS_VALUE)
        transcode.origin = av_rescale_q(transcode.input->start_time, AV_TIME_BASE_Q, encoder->time_base);

    if (transcode.input_stream->duration != AV_NOPTS_VALUE && transcode.input_stream->duration > 0) {
        transcode.total_seconds = transcode.input_stream->duration * av_q2d(transcode.input_stream->time_base);
        if (transcode.input_stream->start_time != AV_NOPTS_VALUE) {
            const double offset = transcode.input_stream->start_time * av_q2d(transcode.input_stream->time_base)
                - static_cast<double>(transcode.origin) / encoder->sample_rate;
            transcode.total_seconds += std::max(0.0, offset);
        }
    } else if (transcode.input->duration != AV_NOPTS_VALUE && transcode.input->duration > 0) {
        transcode.total_seconds = static_cast<double>(transcode.input->duration) / AV_TIME_BASE;
    }
    transcode.report_progress(true);

    while ((result = av_read_frame(transcode.input, transcode.packet)) >= 0) {
        if (transcode.packet->stream_index == transcode.input_stream->index) {
            result = avcodec_send_packet(transcode.decoder, transcode.packet);
            if (result >= 0) result = transcode.receive_frames();
        }
        av_packet_unref(transcode.packet);
        if (result < 0) return fail("Could not transcode audio", result);
    }
    if (result != AVERROR_EOF) return fail("Could not read audio packets", result);
    transcode.finalizing = true;
    transcode.report_progress(true);
    result = transcode.finish();
    if (result < 0) return fail("Could not finish audio output", result);
    uint8_t* bytes = nullptr;
    const int size = avio_close_dyn_buf(transcode.output->pb, &bytes);
    transcode.output->pb = nullptr;
    if (bytes == nullptr || size <= 0) {
        av_free(bytes);
        return fail("FFmpeg produced an empty audio output", AVERROR(EIO));
    }
    *output_pointer = static_cast<unsigned int>(reinterpret_cast<uintptr_t>(bytes));
    *output_size = static_cast<unsigned int>(size);
    return 0;
}
