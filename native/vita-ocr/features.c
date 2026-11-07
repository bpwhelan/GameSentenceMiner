/* A build-time probe used by package validation; check CPU support BEFORE loading. */
int gsm_vocr_avx2_enabled(void)
{
#if defined(__AVX2__) && !defined(VOCR_NO_AVX2)
    return 1;
#else
    return 0;
#endif
}
