#include "asb-build-config.hpp"
#include "include/asb_ffmpeg.h"
#include "json.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libswresample/swresample.h>
}

#include <cstdint>
#include <cstring>
#include <string>

namespace {
std::string last_error;

void set_error(const char* message) {
    last_error = message == nullptr ? "FFmpeg operation failed" : message;
}

void set_ffmpeg_error(const char* operation, int error) {
    char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(error, buffer, sizeof(buffer));
    last_error = std::string(operation) + ": " + buffer;
}

struct InputBuffer {
    const uint8_t* data;
    size_t size;
    size_t position;
};

int read_input(void* opaque, uint8_t* buffer, int buffer_size) {
    auto* input = static_cast<InputBuffer*>(opaque);
    if (input->position >= input->size) return AVERROR_EOF;
    const size_t remaining = input->size - input->position;
    const size_t count = remaining < static_cast<size_t>(buffer_size) ? remaining : static_cast<size_t>(buffer_size);
    std::memcpy(buffer, input->data + input->position, count);
    input->position += count;
    return static_cast<int>(count);
}

int64_t seek_input(void* opaque, int64_t offset, int whence) {
    auto* input = static_cast<InputBuffer*>(opaque);
    if ((whence & ~AVSEEK_FORCE) == AVSEEK_SIZE) return static_cast<int64_t>(input->size);
    const int mode = whence & ~AVSEEK_FORCE;
    int64_t target = 0;
    if (mode == SEEK_SET) target = offset;
    else if (mode == SEEK_CUR) target = static_cast<int64_t>(input->position) + offset;
    else if (mode == SEEK_END) target = static_cast<int64_t>(input->size) + offset;
    else return AVERROR(EINVAL);
    if (target < 0 || static_cast<uint64_t>(target) > input->size) return AVERROR(EINVAL);
    input->position = static_cast<size_t>(target);
    return target;
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

int drain_encoder(AVCodecContext* encoder, AVFormatContext* output, AVPacket* packet) {
    while (true) {
        const int result = avcodec_receive_packet(encoder, packet);
        if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return 0;
        if (result < 0) return result;
        av_packet_rescale_ts(packet, encoder->time_base, output->streams[0]->time_base);
        packet->stream_index = 0;
        const int write_result = av_interleaved_write_frame(output, packet);
        av_packet_unref(packet);
        if (write_result < 0) return write_result;
    }
}

int encode_frame(AVCodecContext* encoder, AVFormatContext* output, AVFrame* frame, AVPacket* packet) {
    const int result = avcodec_send_frame(encoder, frame);
    if (result < 0) return result;
    return drain_encoder(encoder, output, packet);
}

void close_input(AVFormatContext* input_format, AVIOContext* input_io) {
    if (input_format != nullptr) {
        input_format->pb = nullptr;
        avformat_close_input(&input_format);
    }
    if (input_io != nullptr) {
        av_freep(&input_io->buffer);
        avio_context_free(&input_io);
    }
}
} // namespace

extern "C" const char* asb_runtime_info_json(void) noexcept {
    static const std::string info = runtime_info();
    return info.c_str();
}

extern "C" const char* asb_last_error(void) noexcept { return last_error.c_str(); }
extern "C" void asb_free(void* pointer) noexcept { av_free(pointer); }

extern "C" int asb_transcode_audio(const unsigned char* input, unsigned int input_size, int track_index,
                                    unsigned int* output_pointer, unsigned int* output_size) noexcept {
    if (input == nullptr || input_size == 0 || output_pointer == nullptr || output_size == nullptr || track_index < 0) {
        set_error("Invalid audio transcode arguments");
        return -1;
    }
    *output_pointer = 0;
    *output_size = 0;

    InputBuffer input_buffer{input, input_size, 0};
    unsigned char* io_buffer = static_cast<unsigned char*>(av_malloc(32768));
    AVIOContext* input_io = nullptr;
    AVFormatContext* input_format = nullptr;
    AVCodecContext* decoder = nullptr;
    AVCodecContext* encoder = nullptr;
    SwrContext* resampler = nullptr;
    AVFormatContext* output_format = nullptr;
    AVFrame* decoded = nullptr;
    AVFrame* converted = nullptr;
    AVPacket* packet = nullptr;
    int result = 0;
    int audio_stream_index = -1;
    int audio_count = 0;
    AVStream* output_stream = nullptr;
    const AVCodec* decoder_codec = nullptr;
    const AVCodec* encoder_codec = nullptr;
    const void* supported_sample_formats = nullptr;
    const AVSampleFormat* sample_formats = nullptr;
    int64_t next_pts = 0;

    if (io_buffer == nullptr) {
        set_error("Unable to allocate FFmpeg input buffer");
        return -1;
    }
    input_io = avio_alloc_context(io_buffer, 32768, 0, &input_buffer, read_input, nullptr, seek_input);
    if (input_io == nullptr) {
        av_free(io_buffer);
        set_error("Unable to create FFmpeg input context");
        return -1;
    }
    input_format = avformat_alloc_context();
    if (input_format == nullptr) {
        close_input(nullptr, input_io);
        set_error("Unable to allocate FFmpeg input format");
        return -1;
    }
    input_format->pb = input_io;
    input_format->flags |= AVFMT_FLAG_CUSTOM_IO;

    result = avformat_open_input(&input_format, nullptr, nullptr, nullptr);
    if (result < 0) {
        set_ffmpeg_error("Could not open input", result);
        close_input(input_format, input_io);
        return -1;
    }
    result = avformat_find_stream_info(input_format, nullptr);
    if (result < 0) {
        set_ffmpeg_error("Could not read input stream information", result);
        close_input(input_format, input_io);
        return -1;
    }
    for (unsigned int index = 0; index < input_format->nb_streams; ++index) {
        if (input_format->streams[index]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO && audio_count++ == track_index) {
            audio_stream_index = static_cast<int>(index);
        }
    }
    if (audio_stream_index < 0) {
        set_error("The requested audio track does not exist");
        close_input(input_format, input_io);
        return -1;
    }

    decoder_codec = avcodec_find_decoder(input_format->streams[audio_stream_index]->codecpar->codec_id);
    if (decoder_codec == nullptr) {
        set_error("The selected audio codec is not available in this FFmpeg build");
        goto cleanup;
    }
    decoder = avcodec_alloc_context3(decoder_codec);
    if (decoder == nullptr) {
        set_error("Unable to allocate the audio decoder");
        goto cleanup;
    }
    result = avcodec_parameters_to_context(decoder, input_format->streams[audio_stream_index]->codecpar);
    if (result < 0) {
        set_ffmpeg_error("Could not configure audio decoder", result);
        goto cleanup;
    }
    result = avcodec_open2(decoder, decoder_codec, nullptr);
    if (result < 0) {
        set_ffmpeg_error("Could not open audio decoder", result);
        goto cleanup;
    }
    result = avformat_alloc_output_context2(&output_format, nullptr, "mp4", nullptr);
    if (result < 0 || output_format == nullptr) {
        set_ffmpeg_error("Could not create audio output", result < 0 ? result : AVERROR_UNKNOWN);
        goto cleanup;
    }
    encoder_codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (encoder_codec == nullptr) {
        set_error("The AAC encoder is not available in this FFmpeg build");
        goto cleanup;
    }
    output_stream = avformat_new_stream(output_format, nullptr);
    encoder = avcodec_alloc_context3(encoder_codec);
    if (output_stream == nullptr || encoder == nullptr) {
        set_error("Unable to allocate the audio encoder");
        goto cleanup;
    }
    encoder->codec_type = AVMEDIA_TYPE_AUDIO;
    encoder->codec_id = AV_CODEC_ID_AAC;
    encoder->sample_rate = decoder->sample_rate > 0 ? decoder->sample_rate : 48000;
    if (encoder->sample_rate != 44100 && encoder->sample_rate != 48000) encoder->sample_rate = 48000;
    avcodec_get_supported_config(nullptr, encoder_codec, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0, &supported_sample_formats, nullptr);
    sample_formats = static_cast<const AVSampleFormat*>(supported_sample_formats);
    encoder->sample_fmt = sample_formats == nullptr ? AV_SAMPLE_FMT_FLTP : sample_formats[0];
    encoder->bit_rate = 128000;
    av_channel_layout_default(&encoder->ch_layout, 2);
    encoder->time_base = AVRational{1, encoder->sample_rate};
    if (output_format->oformat->flags & AVFMT_GLOBALHEADER) encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    result = avcodec_open2(encoder, encoder_codec, nullptr);
    if (result < 0) {
        set_ffmpeg_error("Could not open AAC encoder", result);
        goto cleanup;
    }
    result = avcodec_parameters_from_context(output_stream->codecpar, encoder);
    if (result < 0) {
        set_ffmpeg_error("Could not configure audio output", result);
        goto cleanup;
    }
    output_stream->time_base = encoder->time_base;
    result = avio_open_dyn_buf(&output_format->pb);
    if (result < 0) {
        set_ffmpeg_error("Could not allocate audio output buffer", result);
        goto cleanup;
    }
    result = avformat_write_header(output_format, nullptr);
    if (result < 0) {
        set_ffmpeg_error("Could not write audio output header", result);
        goto cleanup;
    }
    result = swr_alloc_set_opts2(&resampler, &encoder->ch_layout, encoder->sample_fmt, encoder->sample_rate,
                                 &decoder->ch_layout, decoder->sample_fmt, decoder->sample_rate, 0, nullptr);
    if (result < 0 || resampler == nullptr) {
        set_ffmpeg_error("Could not configure audio resampling", result < 0 ? result : AVERROR(ENOMEM));
        goto cleanup;
    }
    result = swr_init(resampler);
    if (result < 0) {
        set_ffmpeg_error("Could not initialize audio resampling", result);
        goto cleanup;
    }
    decoded = av_frame_alloc();
    converted = av_frame_alloc();
    packet = av_packet_alloc();
    if (decoded == nullptr || converted == nullptr || packet == nullptr) {
        set_error("Unable to allocate audio frames");
        goto cleanup;
    }

    while ((result = av_read_frame(input_format, packet)) >= 0) {
        if (packet->stream_index == audio_stream_index) {
            result = avcodec_send_packet(decoder, packet);
            if (result >= 0) {
                while ((result = avcodec_receive_frame(decoder, decoded)) >= 0) {
                    const int samples = static_cast<int>(av_rescale_rnd(
                        swr_get_delay(resampler, decoder->sample_rate) + decoded->nb_samples,
                        encoder->sample_rate, decoder->sample_rate, AV_ROUND_UP));
                    av_frame_unref(converted);
                    converted->format = encoder->sample_fmt;
                    converted->sample_rate = encoder->sample_rate;
                    converted->nb_samples = samples;
                    result = av_channel_layout_copy(&converted->ch_layout, &encoder->ch_layout);
                    if (result < 0 || av_frame_get_buffer(converted, 0) < 0) break;
                    const int converted_samples = swr_convert(resampler, converted->data, samples,
                                                              const_cast<const uint8_t**>(decoded->extended_data), decoded->nb_samples);
                    if (converted_samples < 0) { result = converted_samples; break; }
                    converted->nb_samples = converted_samples;
                    converted->pts = next_pts;
                    next_pts += converted_samples;
                    result = encode_frame(encoder, output_format, converted, packet);
                    if (result < 0) break;
                }
                if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) result = 0;
            }
        }
        av_packet_unref(packet);
        if (result < 0) break;
    }
    if (result == AVERROR_EOF) result = 0;
    if (result >= 0) {
        result = avcodec_send_packet(decoder, nullptr);
        while (result >= 0) {
            result = avcodec_receive_frame(decoder, decoded);
            if (result == AVERROR_EOF || result == AVERROR(EAGAIN)) break;
            if (result < 0) break;
            const int samples = static_cast<int>(av_rescale_rnd(
                swr_get_delay(resampler, decoder->sample_rate) + decoded->nb_samples,
                encoder->sample_rate, decoder->sample_rate, AV_ROUND_UP));
            av_frame_unref(converted);
            converted->format = encoder->sample_fmt;
            converted->sample_rate = encoder->sample_rate;
            converted->nb_samples = samples;
            if (av_channel_layout_copy(&converted->ch_layout, &encoder->ch_layout) < 0 || av_frame_get_buffer(converted, 0) < 0) {
                result = AVERROR(ENOMEM);
                break;
            }
            const int converted_samples = swr_convert(resampler, converted->data, samples,
                                                      const_cast<const uint8_t**>(decoded->extended_data), decoded->nb_samples);
            if (converted_samples < 0) { result = converted_samples; break; }
            converted->nb_samples = converted_samples;
            converted->pts = next_pts;
            next_pts += converted_samples;
            result = encode_frame(encoder, output_format, converted, packet);
        }
        if (result == AVERROR_EOF || result == AVERROR(EAGAIN)) result = 0;
    }
    if (result >= 0) {
        result = encode_frame(encoder, output_format, nullptr, packet);
        if (result >= 0) result = av_write_trailer(output_format);
    }
    if (result < 0) {
        set_ffmpeg_error("Could not transcode audio", result);
        goto cleanup;
    }
    *output_size = avio_close_dyn_buf(output_format->pb, reinterpret_cast<unsigned char**>(output_pointer));
    output_format->pb = nullptr;
    if (*output_pointer == 0 || *output_size == 0) {
        set_error("FFmpeg produced an empty audio output");
        goto cleanup;
    }
    result = 0;

cleanup:
    if (output_format != nullptr && output_format->pb != nullptr) avio_close_dyn_buf(output_format->pb, nullptr);
    av_packet_free(&packet);
    av_frame_free(&converted);
    av_frame_free(&decoded);
    swr_free(&resampler);
    avcodec_free_context(&encoder);
    avcodec_free_context(&decoder);
    if (output_format != nullptr) avformat_free_context(output_format);
    close_input(input_format, input_io);
    if (result < 0 && *output_pointer != 0) {
        av_free(reinterpret_cast<void*>(*output_pointer));
        *output_pointer = 0;
        *output_size = 0;
    }
    return result < 0 ? -1 : 0;
}
