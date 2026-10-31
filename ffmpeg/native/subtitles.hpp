#ifndef ASB_SUBTITLES_HPP
#define ASB_SUBTITLES_HPP

#include "error.hpp"
#include "host_io.hpp"
#include "json.hpp"
#include <cmath>
#include <memory>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avstring.h>
}

namespace asb::detail {

// Seekable container input for confirmed extraction.
struct SubtitleInput {
    InputBuffer buffer;
    AVFormatContext* format = nullptr;
    AVIOContext* io = nullptr;
    explicit SubtitleInput(double size) : buffer{static_cast<int64_t>(size)} {}
    ~SubtitleInput() {
        if (format) { format->pb = nullptr; avformat_close_input(&format); }
        if (io) { av_freep(&io->buffer); avio_context_free(&io); }
    }
    int open() {
        auto* bytes = static_cast<uint8_t*>(av_malloc(32768));
        if (!bytes) return AVERROR(ENOMEM);
        io = avio_alloc_context(bytes, 32768, 0, &buffer, read_input, nullptr, seek_input);
        if (!io) { av_free(bytes); return AVERROR(ENOMEM); }
        format = avformat_alloc_context();
        if (!format) return AVERROR(ENOMEM);
        format->pb = io;
        format->flags |= AVFMT_FLAG_CUSTOM_IO;
        return avformat_open_input(&format, nullptr, nullptr, nullptr);
    }
};

inline bool valid_subtitle_input(double size) {
    return std::isfinite(size) && size > 0 && size <= 9007199254740991.0 && std::floor(size) == size;
}

inline bool supported_text_codec(AVCodecID id) {
    return id == AV_CODEC_ID_SUBRIP || id == AV_CODEC_ID_TEXT || id == AV_CODEC_ID_ASS ||
           id == AV_CODEC_ID_SSA || id == AV_CODEC_ID_WEBVTT || id == AV_CODEC_ID_MOV_TEXT;
}

inline const char* subtitle_failure(const char* message, int code) {
    fail(message, code);
    return nullptr;
}

// The text encoder removes styling, but retains drawing payloads and literal \\h.
// Strip drawing runs before encoding while keeping karaoke syllables and line breaks.
inline std::string normalize_ass_text(const char* ass) {
    std::string source(ass), output;
    size_t position = 0;
    for (int field = 0; field < 8; ++field) {
        auto comma = source.find(',', position);
        if (comma == std::string::npos) return source;
        position = comma + 1;
    }
    output = source.substr(0, position);
    bool drawing = false;
    while (position < source.size()) {
        if (source[position] == '{') {
            const auto end = source.find('}', position);
            if (end != std::string::npos) {
                const auto block = source.substr(position, end - position + 1);
                for (size_t p = 0; (p = block.find("\\p", p)) != std::string::npos; p += 2) {
                    size_t number = p + 2;
                    while (number < block.size() && block[number] == ' ') ++number;
                    if (number < block.size() && block[number] >= '0' && block[number] <= '9')
                        drawing = block[number] != '0';
                }
                output += block;
                position = end + 1;
                continue;
            }
        }
        if (!drawing) {
            if (source.compare(position, 2, "\\h") == 0) { output += ' '; position += 2; continue; }
            output += source[position];
        }
        ++position;
    }
    return output;
}

struct SubtitleOutput {
    int index;
    AVCodecContext* decoder = nullptr;
    AVCodecContext* encoder = nullptr;
    AVFormatContext* format = nullptr;
    AVStream* source;
    AVPacket* encoded = nullptr;
    int64_t pgs_anchor = AV_NOPTS_VALUE;
    int64_t pgs_last_pts = AV_NOPTS_VALUE;
    bool is_pgs() const { return source->codecpar->codec_id == AV_CODEC_ID_HDMV_PGS_SUBTITLE; }
    double timeline_offset_ms() const { return pgs_anchor == AV_NOPTS_VALUE ? 0 : static_cast<double>(pgs_anchor) / 90; }
    std::vector<uint8_t> bytes = std::vector<uint8_t>(1024 * 1024);
    explicit SubtitleOutput(AVStream* stream) : index(stream->index), source(stream) {}
    ~SubtitleOutput() {
        av_packet_free(&encoded);
        avcodec_free_context(&decoder);
        avcodec_free_context(&encoder);
        if (format && format->pb) { av_freep(&format->pb->buffer); avio_context_free(&format->pb); }
        avformat_free_context(format);
    }
    static int write(void* opaque, const uint8_t* data, int size) {
        const int index = static_cast<SubtitleOutput*>(opaque)->index;
        return asb_write_subtitle_output(index, data, size) == size ? size : AVERROR(EIO);
    }
    int open_pgs() {
        encoded = av_packet_alloc();
        if (!encoded) return AVERROR(ENOMEM);
        int error = avformat_alloc_output_context2(&format, nullptr, "sup", nullptr);
        if (error < 0) return error;
        auto* stream = avformat_new_stream(format, nullptr);
        if (!stream) return AVERROR(ENOMEM);
        if ((error = avcodec_parameters_copy(stream->codecpar, source->codecpar)) < 0) return error;
        stream->time_base = AVRational{1, 90000};
        auto* buffer = static_cast<uint8_t*>(av_malloc(32768));
        if (!buffer) return AVERROR(ENOMEM);
        format->pb = avio_alloc_context(buffer, 32768, 1, this, nullptr, write, nullptr);
        if (!format->pb) { av_free(buffer); return AVERROR(ENOMEM); }
        format->flags |= AVFMT_FLAG_CUSTOM_IO | AVFMT_FLAG_FLUSH_PACKETS;
        format->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
        return avformat_write_header(format, nullptr);
    }
    int remux_pgs(AVPacket* packet, int64_t origin) {
        if (packet->size == 0) return 0;
        if (packet->pts == AV_NOPTS_VALUE) return AVERROR_INVALIDDATA;
        const AVRational clock{1, 90000};
        const int64_t pts = av_rescale_q(packet->pts, source->time_base, clock) - av_rescale_q(origin, AV_TIME_BASE_Q, clock);
        // SUP wraps its 32-bit clock. Keep the origin separately, and reject gaps for
        // which nearest-epoch unwrapping in a standalone SUP would be ambiguous.
        if (pgs_last_pts != AV_NOPTS_VALUE && std::abs(pts - pgs_last_pts) >= (int64_t{1} << 31)) return AVERROR_INVALIDDATA;
        pgs_last_pts = pts;
        if (pgs_anchor == AV_NOPTS_VALUE) pgs_anchor = pts;
        int error = av_packet_ref(encoded, packet);
        if (error < 0) return error;
        encoded->pts = av_rescale_q(pts - pgs_anchor, clock, format->streams[0]->time_base);
        encoded->dts = encoded->pts;
        encoded->duration = av_rescale_q(packet->duration, source->time_base, format->streams[0]->time_base);
        encoded->stream_index = 0;
        error = av_write_frame(format, encoded);
        av_packet_unref(encoded);
        return error;
    }
    int open() {
        if (is_pgs()) return open_pgs();
        const auto* codec = avcodec_find_decoder(source->codecpar->codec_id);
        decoder = avcodec_alloc_context3(codec);
        const auto* text = avcodec_find_encoder(AV_CODEC_ID_TEXT);
        encoder = avcodec_alloc_context3(text);
        encoded = av_packet_alloc();
        if (!codec || !text || !decoder || !encoder || !encoded) return AVERROR(ENOMEM);
        int error = avcodec_parameters_to_context(decoder, source->codecpar);
        if (error < 0) return error;
        decoder->pkt_timebase = source->time_base;
        if ((error = avcodec_open2(decoder, codec, nullptr)) < 0) return error;
        encoder->time_base = AVRational{1, 1000};
        if (decoder->subtitle_header_size > 0) {
            encoder->subtitle_header = static_cast<uint8_t*>(av_mallocz(decoder->subtitle_header_size + 1));
            if (!encoder->subtitle_header) return AVERROR(ENOMEM);
            std::copy_n(decoder->subtitle_header, decoder->subtitle_header_size, encoder->subtitle_header);
            encoder->subtitle_header_size = decoder->subtitle_header_size;
        }
        if ((error = avcodec_open2(encoder, text, nullptr)) < 0) return error;
        if ((error = avformat_alloc_output_context2(&format, nullptr, "srt", nullptr)) < 0) return error;
        auto* stream = avformat_new_stream(format, nullptr);
        if (!stream) return AVERROR(ENOMEM);
        if ((error = avcodec_parameters_from_context(stream->codecpar, encoder)) < 0) return error;
        auto* buffer = static_cast<uint8_t*>(av_malloc(32768));
        if (!buffer) return AVERROR(ENOMEM);
        format->pb = avio_alloc_context(buffer, 32768, 1, this, nullptr, write, nullptr);
        if (!format->pb) { av_free(buffer); return AVERROR(ENOMEM); }
        format->flags |= AVFMT_FLAG_CUSTOM_IO | AVFMT_FLAG_FLUSH_PACKETS;
        return avformat_write_header(format, nullptr);
    }
    int decode(AVPacket* packet, int64_t origin, bool* got) {
        if (is_pgs()) { *got = false; return remux_pgs(packet, origin); }
        AVSubtitle subtitle{};
        int produced = 0;
        int error = avcodec_decode_subtitle2(decoder, &subtitle, &produced, packet);
        *got = produced != 0;
        if (error < 0 || !produced) return error < 0 ? error : 0;
        if (subtitle.num_rects == 0) { avsubtitle_free(&subtitle); return 0; }
        // Decoder subtitle PTS is in AV_TIME_BASE units, display intervals in milliseconds.
        int64_t pts = subtitle.pts;
        if (pts == AV_NOPTS_VALUE && packet->pts != AV_NOPTS_VALUE)
            pts = av_rescale_q(packet->pts, source->time_base, AV_TIME_BASE_Q);
        if (pts == AV_NOPTS_VALUE) { avsubtitle_free(&subtitle); return AVERROR_INVALIDDATA; }
        int64_t start = av_rescale_q(pts - origin, AV_TIME_BASE_Q, AVRational{1, 1000}) + subtitle.start_display_time;
        int64_t end = av_rescale_q(pts - origin, AV_TIME_BASE_Q, AVRational{1, 1000}) + subtitle.end_display_time;
        if (subtitle.end_display_time == UINT32_MAX || end <= start) {
            if (packet->duration > 0) end = start + av_rescale_q(packet->duration, source->time_base, AVRational{1, 1000});
            else if (subtitle.num_rects > 0) { avsubtitle_free(&subtitle); return AVERROR_INVALIDDATA; }
        }
        for (unsigned i = 0; i < subtitle.num_rects; ++i) {
            auto* rect = subtitle.rects[i];
            if (rect->ass) {
                auto normalized = normalize_ass_text(rect->ass);
                av_freep(&rect->ass);
                rect->ass = av_strdup(normalized.c_str());
                if (!rect->ass) { avsubtitle_free(&subtitle); return AVERROR(ENOMEM); }
            }
        }
        const int length = avcodec_encode_subtitle(encoder, bytes.data(), bytes.size(), &subtitle);
        avsubtitle_free(&subtitle);
        if (length < 0) return length;
        if (length == 0 || end <= 0) return 0;
        error = av_new_packet(encoded, length);
        if (error < 0) return error;
        std::copy_n(bytes.data(), length, encoded->data);
        const AVRational milliseconds{1, 1000};
        encoded->pts = av_rescale_q(std::max<int64_t>(0, start), milliseconds, format->streams[0]->time_base);
        encoded->dts = encoded->pts; // overlapping and non-monotonic subtitle cues are valid
        encoded->duration = av_rescale_q(end - std::max<int64_t>(0, start), milliseconds, format->streams[0]->time_base);
        encoded->stream_index = 0;
        error = av_write_frame(format, encoded);
        av_packet_unref(encoded);
        return error;
    }
};

inline const char* extract_subtitles(double size, const char* indexes) {
    static std::string result;
    last_error.clear();
    if (!valid_subtitle_input(size) || !indexes) return subtitle_failure("Invalid subtitle extraction", AVERROR(EINVAL));
    SubtitleInput input(size);
    int error = input.open();
    if (error < 0) return subtitle_failure("Could not open subtitle input", error);
    std::vector<std::unique_ptr<SubtitleOutput>> outputs;
    const char* cursor = indexes;
    while (*cursor) {
        char* end;
        const long index = std::strtol(cursor, &end, 10);
        if (end == cursor || (*end && *end != ',') || index < 0 || index >= input.format->nb_streams)
            return subtitle_failure("Invalid subtitle stream index", AVERROR(EINVAL));
        auto* stream = input.format->streams[index];
        if (stream->codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE || (!supported_text_codec(stream->codecpar->codec_id) && stream->codecpar->codec_id != AV_CODEC_ID_HDMV_PGS_SUBTITLE))
            return subtitle_failure("Unsupported subtitle stream", AVERROR(EINVAL));
        if (std::any_of(outputs.begin(), outputs.end(), [index](const auto& out) { return out->index == index; }))
            return subtitle_failure("Duplicate subtitle stream", AVERROR(EINVAL));
        auto output = std::make_unique<SubtitleOutput>(stream);
        if ((error = output->open()) < 0) return subtitle_failure("Could not open subtitle output", error);
        outputs.push_back(std::move(output));
        cursor = *end ? end + 1 : end;
    }
    if (outputs.empty()) return subtitle_failure("No subtitle streams selected", AVERROR(EINVAL));
    // Read initial packets until each media stream has a presentation origin. Do not
    // use stream-info here: codecs without a video decoder (e.g. H.264) may never get
    // start_time assigned there. Keep selected subtitle packets encountered in the prefix.
    std::vector<int64_t> starts(input.format->nb_streams, AV_NOPTS_VALUE);
    unsigned missing_starts = 0;
    for (unsigned i = 0; i < input.format->nb_streams; ++i) {
        auto* stream = input.format->streams[i];
        const auto type = stream->codecpar->codec_type;
        if (type == AVMEDIA_TYPE_AUDIO || type == AVMEDIA_TYPE_VIDEO) {
            if (stream->start_time != AV_NOPTS_VALUE)
                starts[i] = av_rescale_q(stream->start_time, stream->time_base, AV_TIME_BASE_Q);
            else ++missing_starts;
        }
        if (type == AVMEDIA_TYPE_ATTACHMENT) {
            av_freep(&stream->codecpar->extradata);
            stream->codecpar->extradata_size = 0;
            stream->discard = AVDISCARD_ALL;
        }
    }
    auto release_packet = [](AVPacket* packet) { av_packet_free(&packet); };
    using SavedPacket = std::unique_ptr<AVPacket, decltype(release_packet)>;
    std::vector<SavedPacket> prefix;
    AVPacket* packet = av_packet_alloc();
    if (!packet) return subtitle_failure("Could not allocate subtitle packet", AVERROR(ENOMEM));
    SavedPacket owned_packet(packet, release_packet);
    int64_t prefix_bytes = 0;
    while (missing_starts > 0 && (error = av_read_frame(input.format, packet)) >= 0) {
        const auto* stream = input.format->streams[packet->stream_index];
        const auto type = stream->codecpar->codec_type;
        if ((type == AVMEDIA_TYPE_VIDEO || type == AVMEDIA_TYPE_AUDIO) &&
            starts[packet->stream_index] == AV_NOPTS_VALUE && packet->pts != AV_NOPTS_VALUE) {
            starts[packet->stream_index] = av_rescale_q(packet->pts, stream->time_base, AV_TIME_BASE_Q);
            --missing_starts;
        }
        if (std::any_of(outputs.begin(), outputs.end(), [packet](const auto& out) { return out->index == packet->stream_index; })) {
            prefix_bytes += packet->size;
            if (prefix_bytes > 4 * 1024 * 1024) return subtitle_failure("Subtitle timeline prefix exceeds the memory budget", AVERROR(ENOMEM));
            auto* saved = av_packet_clone(packet);
            if (!saved) return subtitle_failure("Could not retain subtitle preroll", AVERROR(ENOMEM));
            prefix.emplace_back(saved, release_packet);
        }
        av_packet_unref(packet);
    }
    if (missing_starts > 0) return subtitle_failure("Could not resolve the media timeline", AVERROR_INVALIDDATA);
    int64_t origin = AV_NOPTS_VALUE;
    for (const auto start : starts) if (start != AV_NOPTS_VALUE)
        origin = origin == AV_NOPTS_VALUE ? start : std::min(origin, start);
    if (origin == AV_NOPTS_VALUE) origin = 0; // Subtitle-only containers use zero, never their first cue.
    for (unsigned i = 0; i < input.format->nb_streams; ++i)
        if (std::none_of(outputs.begin(), outputs.end(), [i](const auto& out) { return out->index == static_cast<int>(i); }))
            input.format->streams[i]->discard = AVDISCARD_ALL;
    for (auto& saved : prefix) for (auto& output : outputs) if (output->index == saved->stream_index) {
        bool got;
        if ((error = output->decode(saved.get(), origin, &got)) < 0)
            return subtitle_failure("Could not extract subtitle preroll", error);
    }
    prefix.clear();
    while ((error = av_read_frame(input.format, packet)) >= 0) {
        for (auto& output : outputs) if (output->index == packet->stream_index) {
            bool got;
            error = output->decode(packet, origin, &got);
            break;
        }
        av_packet_unref(packet);
        if (error < 0) break;
    }
    if (error != AVERROR_EOF) return subtitle_failure("Could not extract subtitle packets", error);
    result = "[";
    for (auto& output : outputs) {
        AVPacket empty{};
        empty.pts = empty.dts = AV_NOPTS_VALUE;
        bool got;
        do { error = output->decode(&empty, origin, &got); } while (error >= 0 && got);
        if (error < 0 || (error = av_write_trailer(output->format)) < 0)
            return subtitle_failure("Could not finish subtitle output", error);
        avio_flush(output->format->pb);
        if (output->format->pb->error < 0) return subtitle_failure("Could not deliver subtitle output", output->format->pb->error);
        if (result.size() > 1) result += ',';
        result += "{\"streamIndex\":" + std::to_string(output->index);
        if (output->is_pgs())
            result += ",\"extension\":\"sup\",\"mimeType\":\"application/x-pgs\",\"timelineOffsetMs\":" + std::to_string(output->timeline_offset_ms());
        else result += ",\"extension\":\"srt\",\"mimeType\":\"text/x-asbplayer-plain-srt\"";
        result += '}';
    }
    result += ']';
    return result.c_str();
}
} // namespace asb::detail
#endif
