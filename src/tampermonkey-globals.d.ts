// Ambient Tampermonkey host API surface (no runtime effect).
//
// Tampermonkey provides these globals inside the userscript sandbox. They
// are declared here — with intentionally legacy `any` shapes — so that
// `tsc --noEmit` (allowJs/checkJs) can type-check src/runtime.js without
// "Cannot find name 'GM_*'" noise. This file is never executed and never
// bundled (esbuild inputs are src/*.js only; tsconfig only includes this
// one .d.ts explicitly). Wave 2 replaces direct uses with injected
// adapters; until then the declarations stay `any` rather than inventing
// false precision.
//
// IMPORTANT: this file must remain a global script (no top-level
// import/export) so that `interface Window` merges with the DOM lib.

declare function GM_getValue(name: string, defaultValue?: any): any;
declare function GM_setValue(name: string, value?: any): void;
declare function GM_deleteValue(name: string): void;
declare function GM_notification(details: any, ondone?: any): void;
declare function GM_setClipboard(data: string, info?: any): void;
declare function GM_xmlhttpRequest(details: any): any;
declare function GM_registerMenuCommand(name: string, listener: (...args: any[]) => any, accessKey?: string): any;
declare function GM_addStyle(css: string): any;
declare const GM_info: any;

interface Window {
  // Test/diagnostics hook installed by harness and artifact tests.
  __TAA_TEST_HOOK__?: Record<string, any> | undefined;
}
