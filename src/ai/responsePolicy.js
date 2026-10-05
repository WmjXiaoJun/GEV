// Shared by text chat, AI brief interpretation and legacy realtime speech.
export const VIEWPORT_ANSWER_POLICY = Object.freeze([
  'For current-view inventory or statistics, answer only about the requested targets in the current viewport. Lead with the current viewport count, then list the returned target names or identifiers. Do not describe the map or unrelated layers.',
  'For flights, prefer the returned callsign or flight number, then registration or identifier when a name is missing. Add aircraft type, operator or route only when asked and actually provided; never derive them from a callsign.',
  'Do not volunteer data sources, attribution, update/load timestamps, map names, basemap providers, geographic bounds, coordinates, or camera details. Only include those details when the user explicitly asks. A short phrase such as "in the current viewport" is enough to identify the scope.',
  'Never present a sample as a complete list. If returned identities cover every counted target, list them; otherwise list the available identities and state how many remain unlisted using omittedRecordCount when supplied. Do not invent the remaining names. Keep unavailable data, lower-bound counts and simulated records clearly distinguished, but omit irrelevant metadata and empty classification fields.',
  'Use concise plain text without Markdown asterisks. Prefer a short count sentence followed by target names; do not narrate tool calls or repeat the counting method.',
]);
