/**
 * Search that works for Hebrew as people type it (WP 6.1, NFR-16). Text and query are compared
 * after both are brought to one form:
 *   - vowel points (niqqud), cantillation marks and Latin accents are dropped, so "שָׁלוֹם"
 *     finds "שלום" and "Fourviere" finds "Fourvière";
 *   - final letters count as their ordinary form (ך כ, ם מ, ן נ, ף פ, ץ צ), so a word cut short
 *     while typing ("ירושל") still finds "ירושלים";
 *   - geresh and gershayim match the apostrophe and the double quote (צה״ל, צה"ל), maqaf and
 *     the dashes match "-";
 *   - direction marks (RLM, LRM and the isolates) are ignored;
 *   - case is ignored, and runs of spaces are one space.
 * A query of several words finds text that has every word, in any order.
 */

const FINAL: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
const MARKS = /[֑-ׇֽֿׁׂׅׄ̀-ͯ]/g;
const BIDI = /[‎‏‪-‮⁦-⁩؜]/g;

function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(MARKS, "")
    .replace(BIDI, "")
    .replace(/[ךםןףץ]/g, (c) => FINAL[c]!)
    .replace(/[׳‘’`´]/g, "'")
    .replace(/[״“”]/g, '"')
    .replace(/[־‐-―−]/g, "-")
    .toLocaleLowerCase()
    .replace(/\s/g, " ");
}

/** The form search compares. */
export function searchKey(s: string): string {
  return fold(s).replace(/ +/g, " ").trim();
}

/** The words of a query, in search form. */
export function queryWords(query: string): string[] {
  return searchKey(query).split(" ").filter(Boolean);
}

/** True when every word of the query is in one of the fields (an empty query matches all). */
export function matchesQuery(query: string, fields: readonly (string | undefined | null)[]): boolean {
  const words = queryWords(query);
  if (!words.length) return true;
  const hay = fields.map((f) => searchKey(f ?? "")).join("\n");
  return words.every((w) => hay.includes(w));
}

/** True when the whole query, as one phrase, is in the text. */
export function containsPhrase(text: string, query: string): boolean {
  return searchKey(text).includes(searchKey(query));
}

/**
 * Where the query (its first word, or with `phrase` all of it) is in `text`, as [start, end) in
 * the original text, or null: for highlighting what matched, whatever points or final letters
 * the text has.
 */
export function findQuery(text: string, query: string, phrase = false): [number, number] | null {
  const word = phrase ? searchKey(query) : queryWords(query)[0];
  if (!word) return null;
  // The folded text, and for each of its characters the original character it came from.
  let key = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const k = fold(ch);
    for (let j = 0; j < k.length; j++) from.push(i);
    key += k;
    i += ch.length;
  }
  const at = key.indexOf(word);
  if (at < 0) return null;
  const start = from[at]!;
  const lastFrom = from[at + word.length - 1]!;
  let end = lastFrom + String.fromCodePoint(text.codePointAt(lastFrom)!).length;
  // Points and marks after the last letter belong to it.
  while (end < text.length && fold(text[end]!) === "") end++;
  return [start, end];
}
