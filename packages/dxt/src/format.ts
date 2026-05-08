/**
 * format.ts — DXT artifact format constants and helpers.
 *
 * Binary layout of a .dxt file:
 *
 *   Offset   Length   Description
 *   ------   ------   -----------
 *   0        4        Magic: ASCII "DXT1"
 *   4        4        Version: uint32 big-endian (currently 1)
 *   8        32       SHA-256 over the JSON payload (raw bytes)
 *   40       8        JSON payload length: uint64 big-endian (bytes)
 *   48       N        JSON payload (UTF-8)
 *
 * Total header: 48 bytes.
 *
 * Privacy note: command strings can contain secrets such as
 * "--token=<value>" passed as CLI args to stdio MCP servers.
 * Call redactCommand() on args before including them in a DxtJsonPayload.
 */

/** Four-byte magic identifier. All DXT artifacts must begin with these bytes. */
export const DXT_MAGIC = Buffer.from('DXT1', 'ascii');

/** Current format version. Increment when the binary layout changes. */
export const DXT_VERSION = 1;

/** Byte length of the fixed header (magic + version + sha256 + length field). */
export const HEADER_LENGTH = 4 + 4 + 32 + 8; // 48 bytes

/**
 * Patterns matching CLI argument names known to carry secrets.
 * Arguments whose name matches any of these patterns are masked before
 * the payload is serialised to disk.
 */
const SECRET_ARG_PATTERNS: RegExp[] = [
  /^--token=/i,
  /^--api-key=/i,
  /^--secret=/i,
  /^--apikey=/i,
  /^--access-token=/i,
  /^--auth-token=/i,
];

/**
 * Redact secret-looking CLI arguments so they are never written into a DXT
 * artifact.
 *
 * Example:
 *   redactCommand(['--token=sk-abc123', '--port=3000'])
 *   => ['--token=<redacted>', '--port=3000']
 *
 * @param args - The raw args array from the mcp_servers row.
 * @returns A new array with any secret argument values replaced by "<redacted>".
 */
export function redactCommand(args: string[]): string[] {
  return args.map((arg) => {
    for (const pattern of SECRET_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        const eqIdx = arg.indexOf('=');
        if (eqIdx !== -1) {
          return `${arg.slice(0, eqIdx + 1)}<redacted>`;
        }
      }
    }
    return arg;
  });
}
