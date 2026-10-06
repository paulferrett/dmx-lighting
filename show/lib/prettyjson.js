// JSON for files people read and diff: two-space indent, but short arrays of
// numbers or strings ([x, y, z], a group's members) stay on one line.
export function prettyJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/\[\s+((?:-?[\d.e+-]+|"[^"\n]*"|true|false|null)(?:,\s+(?:-?[\d.e+-]+|"[^"\n]*"|true|false|null))*)\s+\]/g,
      (_, inner) => `[${inner.split(/,\s+/).join(', ')}]`) + '\n';
}
