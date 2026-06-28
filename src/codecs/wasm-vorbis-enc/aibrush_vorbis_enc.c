#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>
#include <ogg/ogg.h>
#include <vorbis/codec.h>
#include <vorbis/vorbisenc.h>

typedef struct {
  unsigned char *data;
  int bytes;
  int64_t granulepos;
  int eos;
} AbPacket;

typedef struct {
  vorbis_info vi;
  vorbis_comment vc;
  vorbis_dsp_state vd;
  vorbis_block vb;
  int channels;
  int sample_rate;
  AbPacket *packets;
  int packet_count;
  int packet_capacity;
  int finished;
} AbVorbisEncoder;

static void clear_packets(AbVorbisEncoder *enc) {
  if (!enc) return;
  for (int i = 0; i < enc->packet_count; i++) {
    free(enc->packets[i].data);
    enc->packets[i].data = NULL;
  }
  enc->packet_count = 0;
}

static int reserve_packet(AbVorbisEncoder *enc) {
  if (enc->packet_count < enc->packet_capacity) return 1;
  int next = enc->packet_capacity == 0 ? 8 : enc->packet_capacity * 2;
  AbPacket *packets = (AbPacket *)realloc(enc->packets, (size_t)next * sizeof(AbPacket));
  if (!packets) return 0;
  enc->packets = packets;
  enc->packet_capacity = next;
  return 1;
}

static int queue_packet(AbVorbisEncoder *enc, const ogg_packet *op) {
  if (!enc || !op || op->bytes < 0 || !reserve_packet(enc)) return 0;
  AbPacket *pkt = &enc->packets[enc->packet_count];
  pkt->bytes = (int)op->bytes;
  pkt->granulepos = (int64_t)op->granulepos;
  pkt->eos = (int)op->e_o_s;
  pkt->data = NULL;
  if (pkt->bytes > 0) {
    pkt->data = (unsigned char *)malloc((size_t)pkt->bytes);
    if (!pkt->data) return 0;
    memcpy(pkt->data, op->packet, (size_t)pkt->bytes);
  }
  enc->packet_count++;
  return 1;
}

static int drain_packets(AbVorbisEncoder *enc) {
  if (!enc) return 0;
  while (vorbis_analysis_blockout(&enc->vd, &enc->vb) == 1) {
    if (vorbis_analysis(&enc->vb, NULL) != 0) return 0;
    if (vorbis_bitrate_addblock(&enc->vb) != 0) return 0;
    ogg_packet op;
    while (vorbis_bitrate_flushpacket(&enc->vd, &op)) {
      if (!queue_packet(enc, &op)) return 0;
    }
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE
uintptr_t ab_vorbis_create(int sample_rate, int channels, int bitrate, double quality) {
  if (sample_rate <= 0 || channels <= 0 || channels > 8) return 0;
  AbVorbisEncoder *enc = (AbVorbisEncoder *)calloc(1, sizeof(AbVorbisEncoder));
  if (!enc) return 0;
  enc->channels = channels;
  enc->sample_rate = sample_rate;
  vorbis_info_init(&enc->vi);
  int rc;
  if (bitrate > 0) {
    rc = vorbis_encode_init(&enc->vi, channels, sample_rate, -1, bitrate, -1);
  } else {
    float q = (quality >= -0.1 && quality <= 1.0) ? (float)quality : 0.4f;
    rc = vorbis_encode_init_vbr(&enc->vi, channels, sample_rate, q);
  }
  if (rc != 0) {
    vorbis_info_clear(&enc->vi);
    free(enc);
    return 0;
  }
  vorbis_comment_init(&enc->vc);
  vorbis_comment_add_tag(&enc->vc, "ENCODER", "aibrush-media libvorbisenc wasm");
  if (vorbis_analysis_init(&enc->vd, &enc->vi) != 0) {
    vorbis_comment_clear(&enc->vc);
    vorbis_info_clear(&enc->vi);
    free(enc);
    return 0;
  }
  if (vorbis_block_init(&enc->vd, &enc->vb) != 0) {
    vorbis_dsp_clear(&enc->vd);
    vorbis_comment_clear(&enc->vc);
    vorbis_info_clear(&enc->vi);
    free(enc);
    return 0;
  }
  return (uintptr_t)enc;
}

EMSCRIPTEN_KEEPALIVE
int ab_vorbis_headers(uintptr_t handle) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  if (!enc) return 0;
  clear_packets(enc);
  ogg_packet h0, h1, h2;
  if (vorbis_analysis_headerout(&enc->vd, &enc->vc, &h0, &h1, &h2) != 0) return 0;
  return queue_packet(enc, &h0) && queue_packet(enc, &h1) && queue_packet(enc, &h2);
}

EMSCRIPTEN_KEEPALIVE
int ab_vorbis_feed(uintptr_t handle, const float *interleaved, int frames) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  if (!enc || !interleaved || frames < 0 || enc->finished) return 0;
  if (frames == 0) return 1;
  float **buffer = vorbis_analysis_buffer(&enc->vd, frames);
  if (!buffer) return 0;
  for (int i = 0; i < frames; i++) {
    for (int ch = 0; ch < enc->channels; ch++) {
      buffer[ch][i] = interleaved[i * enc->channels + ch];
    }
  }
  if (vorbis_analysis_wrote(&enc->vd, frames) != 0) return 0;
  return drain_packets(enc);
}

EMSCRIPTEN_KEEPALIVE
int ab_vorbis_finish(uintptr_t handle) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  if (!enc || enc->finished) return 0;
  enc->finished = 1;
  if (vorbis_analysis_wrote(&enc->vd, 0) != 0) return 0;
  return drain_packets(enc);
}

EMSCRIPTEN_KEEPALIVE
int ab_vorbis_packet_count(uintptr_t handle) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  return enc ? enc->packet_count : 0;
}

EMSCRIPTEN_KEEPALIVE
uintptr_t ab_vorbis_packet_data(uintptr_t handle, int index) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  if (!enc || index < 0 || index >= enc->packet_count) return 0;
  return (uintptr_t)enc->packets[index].data;
}

EMSCRIPTEN_KEEPALIVE
int ab_vorbis_packet_bytes(uintptr_t handle, int index) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  if (!enc || index < 0 || index >= enc->packet_count) return 0;
  return enc->packets[index].bytes;
}

EMSCRIPTEN_KEEPALIVE
double ab_vorbis_packet_granulepos(uintptr_t handle, int index) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  if (!enc || index < 0 || index >= enc->packet_count) return -1;
  return (double)enc->packets[index].granulepos;
}

EMSCRIPTEN_KEEPALIVE
int ab_vorbis_packet_eos(uintptr_t handle, int index) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  if (!enc || index < 0 || index >= enc->packet_count) return 0;
  return enc->packets[index].eos;
}

EMSCRIPTEN_KEEPALIVE
void ab_vorbis_clear_packets(uintptr_t handle) {
  clear_packets((AbVorbisEncoder *)handle);
}

EMSCRIPTEN_KEEPALIVE
void ab_vorbis_destroy(uintptr_t handle) {
  AbVorbisEncoder *enc = (AbVorbisEncoder *)handle;
  if (!enc) return;
  clear_packets(enc);
  free(enc->packets);
  vorbis_block_clear(&enc->vb);
  vorbis_dsp_clear(&enc->vd);
  vorbis_comment_clear(&enc->vc);
  vorbis_info_clear(&enc->vi);
  free(enc);
}
