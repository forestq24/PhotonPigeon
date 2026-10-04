// Stand-in for Android's logging header so OpenPigeon's pool engine builds unmodified on macOS.
// The engine only uses it for verbose tracing, which we drop.
#pragma once
#define ANDROID_LOG_VERBOSE 2
static inline int __android_log_print(int, const char*, const char*, ...) { return 0; }
