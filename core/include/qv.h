/* Voice2QR core — C ABI.
 *
 * The contract between the shared Rust core (voice2qr-core) and its
 * faces: the Web face calls this from WASM, the Android face through JNI.
 * Design: docs/core-api.md §4.
 *
 * Ownership:
 *  - Input pointers (payload, pcm) are borrowed for the duration of the
 *    call only; the core never retains them.
 *  - A QvBytes filled by a successful call is owned by the caller and
 *    must be released exactly once with qv_bytes_free().
 *  - A QvEncoder handle is released by exactly one of
 *    qv_encoder_finalize() (which always frees it, success or failure)
 *    or qv_encoder_free().
 */
#ifndef VOICE2QR_QV_H
#define VOICE2QR_QV_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    QV_OK = 0,
    QV_ERR_NOT_QV = 1,
    QV_ERR_UNSUPPORTED_VERSION = 2,
    QV_ERR_MALFORMED = 3,
    QV_ERR_NO_VOICE = 4,
    QV_ERR_UNSUPPORTED_BPS = 5,
    QV_ERR_TOO_LARGE = 6,
    QV_ERR_CODEC = 7,
    QV_ERR_INVALID_ARGUMENT = 8
} QvStatus;

/* A byte buffer owned by the caller (see ownership rules above).
 * For qv_decode, the contents are little-endian int16 samples;
 * the sample count is len / 2. */
typedef struct {
    uint8_t *data;
    size_t len;
} QvBytes;

/* Payload summary written by qv_inspect.
 * bps / frame_count / duration_ms are valid only when has_voice != 0. */
typedef struct {
    uint8_t version;
    int has_voice;
    uint16_t bps;
    uint32_t frame_count;
    uint32_t duration_ms;
    int has_text;
    int has_image;
} QvInfo;

/* Inspect a payload without changing it. */
QvStatus qv_inspect(const uint8_t *payload, size_t len, QvInfo *out);

/* Decode a payload's VOICE section to 8 kHz mono PCM (as QvBytes of
 * little-endian int16 samples). Other sections are skipped. */
QvStatus qv_decode(const uint8_t *payload, size_t len, QvBytes *out_pcm);

/* One-shot encode of 8 kHz mono PCM into a QV payload.
 * capacity is the maximum payload size in bytes (e.g. 2331 for a QR at
 * error-correction level M). */
QvStatus qv_encode(const int16_t *pcm, size_t samples, uint16_t bps,
                   size_t capacity, QvBytes *out_payload);

typedef struct QvEncoder QvEncoder; /* opaque */

QvStatus qv_encoder_new(uint16_t bps, size_t capacity, QvEncoder **out);
QvStatus qv_encoder_push(QvEncoder *enc, const int16_t *pcm, size_t samples);
/* Either out pointer may be NULL. payload_len is the size the finished
 * payload would have if finalized now (including a final padded frame
 * for pending samples). */
QvStatus qv_encoder_stats(const QvEncoder *enc, uint32_t *frames,
                          size_t *payload_len);
/* Finalize and free the handle (always freed, success or failure). */
QvStatus qv_encoder_finalize(QvEncoder *enc, QvBytes *out_payload);
void qv_encoder_free(QvEncoder *enc);

void qv_bytes_free(QvBytes *b);

/* Longest recording (ms) that fits capacity at this bit rate; 0 if the
 * bit rate is unknown. */
uint32_t qv_max_duration_ms(uint16_t bps, size_t capacity);

#ifdef __cplusplus
}
#endif

#endif /* VOICE2QR_QV_H */
