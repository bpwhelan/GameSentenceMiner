/* Keep the upstream model layout opaque to Python. */
#include "vocr_textspot6.h"

size_t gsm_vocr_spotter_model_bytes(void) { return sizeof(vocr_textspot6); }
size_t gsm_vocr_spotter_box_bytes(void) { return sizeof(VocrTextspot6Box); }
size_t gsm_vocr_spotter_set_bytes(void) { return sizeof(VocrTextspot6Set); }
