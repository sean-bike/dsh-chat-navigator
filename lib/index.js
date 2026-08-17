/**
 * dsh-chat-navigator — Host half.
 *
 * The host half is a no-op carrier: this package is a pure client plugin
 * (progress bar + collapse UI). It exists so the package is a valid dual-face
 * (`dsh.client`) package and the browser half enters the module table.
 * All behavior lives in ./client.js.
 */
export function apply() {
  // no-op: pure client plugin.
}
