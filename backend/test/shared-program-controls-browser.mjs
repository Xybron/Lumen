// Preserve the existing regression entry point while exercising the unified
// Outputs panel and focused navigation with the expanded regression.
process.env.LUMEN_FOCUSED_NAVIGATION_TEST_PORT ??= process.env.LUMEN_SHARED_CONTROLS_TEST_PORT || '3498';
await import('./focused-navigation-browser.mjs');
