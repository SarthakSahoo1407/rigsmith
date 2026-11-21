// Dev only: lets gear render in a plain browser (no JUCE) for preview.html and screenshots.
(globalThis as Record<string, unknown>).__JUCE__ = { backend: { addEventListener: () => ['', 0], removeEventListener() {}, emitEvent() {} } };
