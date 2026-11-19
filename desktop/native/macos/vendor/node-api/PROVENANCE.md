Stable Node-API C headers copied without modification from Node.js v22.13.0:
https://github.com/nodejs/node/tree/v22.13.0/src

Only node_api.h, node_api_types.h, js_native_api.h and js_native_api_types.h
are used. The activation addon targets stable Node-API version 8, not the
version-specific V8/Electron ABI. See LICENSE for the Node.js license.
