#ifndef ASB_FFMPEG_H
#define ASB_FFMPEG_H

#ifdef __cplusplus
#define ASB_NOEXCEPT noexcept
extern "C" {
#else
#define ASB_NOEXCEPT
#endif

const char* asb_runtime_info_json(void) ASB_NOEXCEPT;

int asb_transcode_audio(const unsigned char* input, unsigned int input_size, int track_index,
                        unsigned int* output_pointer, unsigned int* output_size) ASB_NOEXCEPT;
void asb_free(void* pointer) ASB_NOEXCEPT;
const char* asb_last_error(void) ASB_NOEXCEPT;

#ifdef __cplusplus
}
#endif
#undef ASB_NOEXCEPT

#endif
